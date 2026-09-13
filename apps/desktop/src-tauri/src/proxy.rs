//! Node sidecar proxy backend.
//!
//! Implements [`HostBackend`] by sending fixed loopback HTTP/1.1 requests to
//! the Node Local Agent Host. Never uses a shell, never binds non-loopback,
//! never leaks paths or raw errors across the IPC boundary.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::backend::{
    CancelTurnResponse, ConfigBackend, ConfigDeleteResponse, ConfigSnapshotResponse,
    CreateSessionResponse, HostBackend, HostSession, HostSessionStatus, ProviderConfigResponse,
    RouteConfigResponse, StartTurnResponse,
};
use crate::errors::HostError;

/// Fixed loopback address of the Node sidecar.
const SIDECAR_HOST: &str = "127.0.0.1";
/// Bounded connect timeout for sidecar HTTP requests.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounded read timeout for sidecar HTTP requests.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum HTTP response header size.
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Maximum JSON body size for non-streaming responses.
const MAX_JSON_BODY_BYTES: usize = 1024 * 1024;
/// Maximum NDJSON line size.
const MAX_NDJSON_LINE_BYTES: usize = 256 * 1024;
/// Maximum total NDJSON size.
const MAX_NDJSON_TOTAL_BYTES: usize = 16 * 1024 * 1024;

/// Injectable event sink so tests never need a real Tauri AppHandle.
pub trait NativeEventSink: Send + Sync {
    fn emit(&self, session_id: &str, turn_id: &str, event: &Value) -> Result<(), HostError>;
}

/// Recording sink for tests.
pub struct RecordingEventSink {
    events: std::sync::Mutex<Vec<(String, String, Value)>>,
}

impl RecordingEventSink {
    pub fn new() -> Self {
        Self {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn events(&self) -> Vec<(String, String, Value)> {
        self.events.lock().expect("lock").clone()
    }
}

impl NativeEventSink for RecordingEventSink {
    fn emit(&self, session_id: &str, turn_id: &str, event: &Value) -> Result<(), HostError> {
        self.events.lock().expect("lock").push((
            String::from(session_id),
            String::from(turn_id),
            event.clone(),
        ));
        Ok(())
    }
}

/// Production event sink that emits through Tauri's official event API.
pub struct TauriEventSink {
    handle: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(handle: tauri::AppHandle) -> Self {
        Self { handle }
    }
}

impl NativeEventSink for TauriEventSink {
    fn emit(&self, session_id: &str, turn_id: &str, event: &Value) -> Result<(), HostError> {
        use tauri::Emitter;
        let envelope = serde_json::json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "event": event,
        });
        self.handle
            .emit("agent_turn_event", &envelope)
            .map_err(|_| HostError::sidecar_proxy_unavailable())
    }
}

/// HTTP response metadata is separated from its body reader so a streaming
/// turn can return its turn id before the body reaches EOF.
struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: BodyReader,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Copy)]
enum BodyFraming {
    ContentLength(usize),
    Chunked,
    UntilEof,
}

/// Bounded incremental response body reader. It supports the two response
/// framings emitted by Node's HTTP server and never reads a non-success body
/// unless the caller explicitly asks for it.
struct BodyReader {
    stream: TcpStream,
    buffer: Vec<u8>,
    framing: BodyFraming,
    remaining: usize,
    chunk_remaining: usize,
    chunk_needs_crlf: bool,
    chunk_done: bool,
    eof: bool,
    total: usize,
}

impl BodyReader {
    fn new(stream: TcpStream, initial: Vec<u8>, framing: BodyFraming) -> Self {
        let remaining = match framing {
            BodyFraming::ContentLength(length) => length,
            BodyFraming::Chunked | BodyFraming::UntilEof => 0,
        };
        Self {
            stream,
            buffer: initial,
            framing,
            remaining,
            chunk_remaining: 0,
            chunk_needs_crlf: false,
            chunk_done: false,
            eof: false,
            total: 0,
        }
    }

    fn fill(&mut self) -> Result<bool, HostError> {
        if self.eof {
            return Ok(false);
        }
        let mut bytes = [0u8; 4096];
        let count = self
            .stream
            .read(&mut bytes)
            .map_err(|_| HostError::sidecar_proxy_unavailable())?;
        if count == 0 {
            self.eof = true;
            return Ok(false);
        }
        self.buffer.extend_from_slice(&bytes[..count]);
        Ok(true)
    }

    fn take(&mut self, count: usize) -> Vec<u8> {
        self.buffer.drain(..count).collect()
    }

    fn ensure(&mut self, count: usize) -> Result<(), HostError> {
        while self.buffer.len() < count {
            if !self.fill()? {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        Ok(())
    }

    fn read_line(&mut self) -> Result<Option<Vec<u8>>, HostError> {
        loop {
            if let Some(end) = self.buffer.windows(2).position(|window| window == b"\r\n") {
                let line = self.take(end);
                self.buffer.drain(..2);
                return Ok(Some(line));
            }
            if self.buffer.len() > MAX_HEADER_BYTES {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if !self.fill()? {
                return Ok(None);
            }
        }
    }

    fn account(&mut self, count: usize, limit: usize) -> Result<(), HostError> {
        self.total = self
            .total
            .checked_add(count)
            .ok_or(HostError::sidecar_proxy_protocol_error())?;
        if self.total > limit {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
        Ok(())
    }

    fn next_piece(&mut self, limit: usize) -> Result<Option<Vec<u8>>, HostError> {
        match self.framing {
            BodyFraming::ContentLength(_) => {
                if self.remaining == 0 {
                    return Ok(None);
                }
                if self.buffer.is_empty() && !self.fill()? {
                    return Err(HostError::sidecar_proxy_protocol_error());
                }
                let count = self.remaining.min(self.buffer.len()).min(4096);
                let piece = self.take(count);
                self.remaining -= count;
                self.account(count, limit)?;
                Ok(Some(piece))
            }
            BodyFraming::UntilEof => {
                if self.buffer.is_empty() && !self.fill()? {
                    return Ok(None);
                }
                let piece = self.take(self.buffer.len().min(4096));
                self.account(piece.len(), limit)?;
                Ok(Some(piece))
            }
            BodyFraming::Chunked => {
                if self.chunk_done {
                    return Ok(None);
                }
                if self.chunk_needs_crlf {
                    self.ensure(2)?;
                    if self.take(2) != b"\r\n" {
                        return Err(HostError::sidecar_proxy_protocol_error());
                    }
                    self.chunk_needs_crlf = false;
                }

                if self.chunk_remaining == 0 {
                    let line = self
                        .read_line()?
                        .ok_or(HostError::sidecar_proxy_protocol_error())?;
                    let text = std::str::from_utf8(&line)
                        .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
                    let size_text = text.split(';').next().unwrap_or("").trim();
                    let size = usize::from_str_radix(size_text, 16)
                        .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
                    if size == 0 {
                        loop {
                            let trailer = self
                                .read_line()?
                                .ok_or(HostError::sidecar_proxy_protocol_error())?;
                            if trailer.is_empty() {
                                self.chunk_done = true;
                                return Ok(None);
                            }
                        }
                    }
                    if size > limit.saturating_sub(self.total) {
                        return Err(HostError::sidecar_proxy_protocol_error());
                    }
                    self.chunk_remaining = size;
                }

                if self.buffer.is_empty() && !self.fill()? {
                    return Err(HostError::sidecar_proxy_protocol_error());
                }
                let count = self.chunk_remaining.min(self.buffer.len()).min(4096);
                let piece = self.take(count);
                self.chunk_remaining -= count;
                if self.chunk_remaining == 0 {
                    self.chunk_needs_crlf = true;
                }
                self.account(count, limit)?;
                Ok(Some(piece))
            }
        }
    }

    fn read_to_end(&mut self, limit: usize) -> Result<Vec<u8>, HostError> {
        let mut result = Vec::new();
        while let Some(piece) = self.next_piece(limit)? {
            result.extend_from_slice(&piece);
        }
        Ok(result)
    }
}

/// Sends a fixed loopback HTTP/1.1 POST request and returns after response
/// headers, never after the response body.
fn http_post(
    port: u16,
    path: &str,
    body: &str,
    close_connection: bool,
) -> Result<HttpResponse, HostError> {
    http_request("POST", port, path, body, close_connection)
}

fn http_request(
    method: &str,
    port: u16,
    path: &str,
    body: &str,
    close_connection: bool,
) -> Result<HttpResponse, HostError> {
    let addr = format!("{SIDECAR_HOST}:{port}");
    let socket = addr
        .parse()
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;
    let mut stream = TcpStream::connect_timeout(&socket, CONNECT_TIMEOUT)
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;
    stream
        .set_write_timeout(Some(READ_TIMEOUT))
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;

    let connection = if close_connection {
        "close"
    } else {
        "keep-alive"
    };
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {SIDECAR_HOST}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {connection}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;
    stream
        .flush()
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;

    read_http_response(stream)
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Reads only the HTTP response headers. The returned BodyReader owns the
/// socket and can be consumed incrementally by a background turn worker.
fn read_http_response(mut stream: TcpStream) -> Result<HttpResponse, HostError> {
    let mut raw = Vec::new();
    let mut bytes = [0u8; 4096];
    let header_end = loop {
        let count = stream
            .read(&mut bytes)
            .map_err(|_| HostError::sidecar_proxy_unavailable())?;
        if count == 0 {
            return Err(HostError::sidecar_proxy_unavailable());
        }
        raw.extend_from_slice(&bytes[..count]);
        if raw.len() > MAX_HEADER_BYTES {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
        if let Some(end) = find_header_end(&raw) {
            break end;
        }
    };

    let header_text = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    let mut status_parts = status_line.split_whitespace();
    let version = status_parts.next().unwrap_or("");
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    let status = status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or(HostError::sidecar_proxy_protocol_error())?;

    let mut headers = Vec::new();
    for line in lines {
        let (key, value) = line
            .split_once(':')
            .ok_or(HostError::sidecar_proxy_protocol_error())?;
        let key = key.trim();
        if key.is_empty() {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
        headers.push((key.to_ascii_lowercase(), value.trim().to_string()));
    }

    let content_length = headers
        .iter()
        .find(|(key, _)| key == "content-length")
        .map(|(_, value)| {
            value
                .parse::<usize>()
                .map_err(|_| HostError::sidecar_proxy_protocol_error())
        })
        .transpose()?;
    let transfer_encoding = headers
        .iter()
        .find(|(key, _)| key == "transfer-encoding")
        .map(|(_, value)| value.to_ascii_lowercase());
    if content_length.is_some() && transfer_encoding.is_some() {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    let framing = match transfer_encoding.as_deref() {
        Some("chunked") => BodyFraming::Chunked,
        Some(_) => return Err(HostError::sidecar_proxy_protocol_error()),
        None => match content_length {
            Some(length) => BodyFraming::ContentLength(length),
            None => BodyFraming::UntilEof,
        },
    };

    let body_start = header_end + 4;
    let initial = raw[body_start..].to_vec();
    Ok(HttpResponse {
        status,
        headers,
        body: BodyReader::new(stream, initial, framing),
    })
}

/// Parses a session from the sidecar's JSON response.
fn parse_session_response(body: &[u8]) -> Result<CreateSessionResponse, HostError> {
    let text = std::str::from_utf8(body).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| HostError::sidecar_proxy_protocol_error())?;

    let obj = value
        .as_object()
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    if obj.len() != 1 {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    let session_obj = obj
        .get("session")
        .and_then(Value::as_object)
        .ok_or(HostError::sidecar_proxy_protocol_error())?;

    let allowed = ["id", "status", "createdAt", "updatedAt", "activeTurnId"];
    for key in session_obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
    }

    let id = session_obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(HostError::sidecar_proxy_protocol_error())?
        .to_string();

    let status_str = session_obj
        .get("status")
        .and_then(Value::as_str)
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    let status = match status_str {
        "idle" => HostSessionStatus::Idle,
        "running" => HostSessionStatus::Running,
        "completed" => HostSessionStatus::Completed,
        "cancelled" => HostSessionStatus::Cancelled,
        "failed" => HostSessionStatus::Failed,
        _ => return Err(HostError::sidecar_proxy_protocol_error()),
    };

    let created_at = session_obj
        .get("createdAt")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    let updated_at = session_obj
        .get("updatedAt")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or(HostError::sidecar_proxy_protocol_error())?;

    let active_turn_id = match session_obj.get("activeTurnId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => return Err(HostError::sidecar_proxy_protocol_error()),
    };

    let session = HostSession::new(id, status, created_at, updated_at, active_turn_id)?;
    Ok(CreateSessionResponse::new(session))
}

fn config_keys_are_allowed<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, HostError> {
    let object = value
        .as_object()
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    if object
        .keys()
        .any(|key| !allowed.iter().any(|candidate| *candidate == key))
    {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    Ok(object)
}

fn validate_config_provider(value: &Value) -> Result<Value, HostError> {
    let object = config_keys_are_allowed(
        value,
        &[
            "id",
            "name",
            "protocol",
            "baseUrl",
            "credentialRef",
            "models",
            "enabled",
        ],
    )?;
    for key in ["id", "name", "protocol", "baseUrl"] {
        if object.get(key).and_then(Value::as_str).is_none() {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
    }
    if object.get("protocol").and_then(Value::as_str) != Some("anthropic_messages")
        && object.get("protocol").and_then(Value::as_str) != Some("openai_compatible")
    {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    if !matches!(
        object.get("credentialRef"),
        Some(Value::Null) | Some(Value::String(_))
    ) {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    let models = object
        .get("models")
        .and_then(Value::as_array)
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    if models.is_empty() || models.iter().any(|model| model.as_str().is_none()) {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    if object.get("enabled").and_then(Value::as_bool).is_none() {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    Ok(value.clone())
}

fn validate_config_route(value: &Value) -> Result<Value, HostError> {
    let object = config_keys_are_allowed(
        value,
        &[
            "id",
            "name",
            "providerId",
            "model",
            "enabled",
            "fallbackProviderIds",
        ],
    )?;
    for key in ["id", "name", "providerId", "model"] {
        if object.get(key).and_then(Value::as_str).is_none() {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
    }
    if object.get("enabled").and_then(Value::as_bool).is_none() {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    if let Some(fallbacks) = object.get("fallbackProviderIds") {
        if !fallbacks.is_array()
            || fallbacks
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.as_str().is_none()))
        {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
    }
    Ok(value.clone())
}

fn parse_config_snapshot(body: &[u8]) -> Result<ConfigSnapshotResponse, HostError> {
    let text = std::str::from_utf8(body).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let object = config_keys_are_allowed(&value, &["version", "providers", "routes"])?;
    if object.len() != 3 || object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    let providers = object
        .get("providers")
        .and_then(Value::as_array)
        .ok_or(HostError::sidecar_proxy_protocol_error())?
        .iter()
        .map(validate_config_provider)
        .collect::<Result<Vec<_>, _>>()?;
    let routes = object
        .get("routes")
        .and_then(Value::as_array)
        .ok_or(HostError::sidecar_proxy_protocol_error())?
        .iter()
        .map(validate_config_route)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ConfigSnapshotResponse {
        version: 1,
        providers,
        routes,
    })
}

fn parse_provider_config_response(body: &[u8]) -> Result<ProviderConfigResponse, HostError> {
    let text = std::str::from_utf8(body).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let object = config_keys_are_allowed(&value, &["provider"])?;
    if object.len() != 1 {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    Ok(ProviderConfigResponse {
        provider: validate_config_provider(
            object
                .get("provider")
                .ok_or(HostError::sidecar_proxy_protocol_error())?,
        )?,
    })
}

fn parse_route_config_response(body: &[u8]) -> Result<RouteConfigResponse, HostError> {
    let text = std::str::from_utf8(body).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let object = config_keys_are_allowed(&value, &["route"])?;
    if object.len() != 1 {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    Ok(RouteConfigResponse {
        route: validate_config_route(
            object
                .get("route")
                .ok_or(HostError::sidecar_proxy_protocol_error())?,
        )?,
    })
}

fn parse_config_delete_response(body: &[u8]) -> Result<ConfigDeleteResponse, HostError> {
    let text = std::str::from_utf8(body).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let object = config_keys_are_allowed(&value, &["ok"])?;
    if object.len() != 1 || object.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    Ok(ConfigDeleteResponse { ok: true })
}

/// Validates an AgentEvent from the sidecar NDJSON stream.
fn validate_agent_event(event: &Value, turn_id: &str) -> Result<(), HostError> {
    let obj = event
        .as_object()
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    let event_type = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or(HostError::sidecar_proxy_protocol_error())?;

    let request_id = obj
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    if request_id != turn_id {
        return Err(HostError::sidecar_proxy_protocol_error());
    }

    match event_type {
        "text_delta" => {
            if obj.get("text").and_then(Value::as_str).is_none() {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if obj.len() != 3 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        "tool_call" => {
            if obj.get("id").and_then(Value::as_str).is_none()
                || obj.get("name").and_then(Value::as_str).is_none()
                || !obj.get("input").is_some_and(Value::is_object)
            {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if obj.len() != 5 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        "usage" => {
            let input = obj.get("inputTokens").and_then(Value::as_f64);
            let output = obj.get("outputTokens").and_then(Value::as_f64);
            if input.is_none() || output.is_none() {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if obj.len() != 4 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        "route_selected" => {
            if obj.get("routeId").and_then(Value::as_str).is_none()
                || obj.get("model").and_then(Value::as_str).is_none()
            {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if obj.len() != 4 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        "completed" => {
            if obj.len() != 2 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        "error" => {
            if obj.get("code").and_then(Value::as_str).is_none()
                || obj.get("message").and_then(Value::as_str).is_none()
                || obj.get("retryable").and_then(Value::as_bool).is_none()
            {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if obj.len() != 5 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
        }
        _ => return Err(HostError::sidecar_proxy_protocol_error()),
    }

    Ok(())
}

fn is_terminal_event(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("completed") | Some("error")
    )
}

struct NdjsonReader {
    body: BodyReader,
    line: Vec<u8>,
}

impl NdjsonReader {
    fn new(body: BodyReader) -> Self {
        Self {
            body,
            line: Vec::new(),
        }
    }

    fn next_event(&mut self, turn_id: &str) -> Result<Option<Value>, HostError> {
        loop {
            if let Some(end) = self.line.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.line.drain(..=end).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.is_empty() {
                    continue;
                }
                let text = std::str::from_utf8(&line)
                    .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
                let event = serde_json::from_str(text)
                    .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
                validate_agent_event(&event, turn_id)?;
                return Ok(Some(event));
            }

            if self.line.len() > MAX_NDJSON_LINE_BYTES {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            match self.body.next_piece(MAX_NDJSON_TOTAL_BYTES)? {
                Some(piece) => {
                    self.line.extend_from_slice(&piece);
                    if self.line.len() > MAX_NDJSON_LINE_BYTES {
                        return Err(HostError::sidecar_proxy_protocol_error());
                    }
                }
                None => {
                    if self.line.is_empty() {
                        return Ok(None);
                    }
                    return Err(HostError::sidecar_proxy_protocol_error());
                }
            }
        }
    }
}

fn fixed_stream_error(turn_id: &str) -> Value {
    serde_json::json!({
        "type": "error",
        "requestId": turn_id,
        "code": "gateway_error",
        "message": "Model gateway request failed.",
        "retryable": false,
    })
}

fn emit_fixed_stream_error(
    sink: &dyn NativeEventSink,
    session_id: &str,
    turn_id: &str,
) -> Result<(), HostError> {
    sink.emit(session_id, turn_id, &fixed_stream_error(turn_id))
}

fn sanitize_event(event: &Value, turn_id: &str) -> Value {
    if event.get("type").and_then(Value::as_str) != Some("error") {
        return event.clone();
    }
    let code = event.get("code").and_then(Value::as_str).unwrap_or("");
    let (safe_code, message) = match code {
        "aborted" => ("aborted", "Request aborted."),
        "runner_error" => ("runner_error", "Agent runner failed."),
        "rate_limited" => ("rate_limited", "Model gateway request failed."),
        "upstream_unavailable" => ("upstream_unavailable", "Model gateway request failed."),
        "provider_protocol_error" => ("provider_protocol_error", "Model gateway request failed."),
        _ => ("gateway_error", "Model gateway request failed."),
    };
    serde_json::json!({
        "type": "error",
        "requestId": turn_id,
        "code": safe_code,
        "message": message,
        "retryable": event.get("retryable").and_then(Value::as_bool).unwrap_or(false),
    })
}

struct StreamStart {
    ready: mpsc::Receiver<Result<(), HostError>>,
    release: mpsc::Sender<()>,
}

/// The production Node sidecar proxy backend.
pub struct NodeSidecarBackend {
    port: u16,
    sink: Arc<dyn NativeEventSink>,
}

impl NodeSidecarBackend {
    pub fn new(port: u16, sink: Box<dyn NativeEventSink>) -> Self {
        Self {
            port,
            sink: Arc::from(sink),
        }
    }

    /// Streams the body in a detached worker. The first event is validated
    /// before the command returns, but is released only after the caller has
    /// received the turn id so the renderer cannot filter it out accidentally.
    fn spawn_stream_worker(
        &self,
        session_id: String,
        turn_id: String,
        body: BodyReader,
    ) -> StreamStart {
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::channel();
        let sink = Arc::clone(&self.sink);
        thread::spawn(move || {
            let mut reader = NdjsonReader::new(body);
            let first = reader.next_event(&turn_id);
            match first {
                Ok(Some(event)) => {
                    if ready_sender.send(Ok(())).is_err() {
                        return;
                    }
                    if release_receiver.recv().is_err() {
                        return;
                    }
                    let safe = sanitize_event(&event, &turn_id);
                    if sink.emit(&session_id, &turn_id, &safe).is_err() {
                        return;
                    }
                    if is_terminal_event(&safe) {
                        return;
                    }

                    loop {
                        match reader.next_event(&turn_id) {
                            Ok(Some(event)) => {
                                let safe = sanitize_event(&event, &turn_id);
                                if sink.emit(&session_id, &turn_id, &safe).is_err() {
                                    return;
                                }
                                if is_terminal_event(&safe) {
                                    return;
                                }
                            }
                            Ok(None) | Err(_) => {
                                let _ = emit_fixed_stream_error(&*sink, &session_id, &turn_id);
                                return;
                            }
                        }
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = ready_sender.send(Err(HostError::sidecar_proxy_protocol_error()));
                }
            }
        });
        StreamStart {
            ready: ready_receiver,
            release: release_sender,
        }
    }
}

/// Percent-encodes a session/turn id for use in a URL path segment.
fn encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                String::from(b as char)
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

impl HostBackend for NodeSidecarBackend {
    fn create_session(&self) -> Result<CreateSessionResponse, HostError> {
        let mut response = http_post(self.port, "/v1/sessions", "{}", true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_session_response(&body)
    }

    fn start_turn(
        &self,
        session_id: &str,
        request: &Value,
    ) -> Result<StartTurnResponse, HostError> {
        // Build a safe copy of the request with only allowed fields.
        let obj = request.as_object().ok_or(HostError::invalid_request())?;
        let mut safe = serde_json::Map::new();
        for key in ["messages", "tools", "routeId", "model", "maxTokens"] {
            if let Some(value) = obj.get(key) {
                safe.insert(String::from(key), value.clone());
            }
        }
        let body = serde_json::to_string(&Value::Object(safe))
            .map_err(|_| HostError::invalid_request())?;

        let path = format!("/v1/sessions/{}/turns", encode_path_segment(session_id));
        let response = http_post(self.port, &path, &body, true)?;

        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }

        let turn_id = response
            .header("x-agent-turn-id")
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .filter(|s| s.chars().all(|c| c.is_ascii_graphic()))
            .ok_or(HostError::sidecar_proxy_protocol_error())?
            .to_string();

        let stream =
            self.spawn_stream_worker(session_id.to_string(), turn_id.clone(), response.body);
        match stream.ready.recv_timeout(READ_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(HostError::sidecar_proxy_unavailable()),
        }
        StartTurnResponse::with_stream_release(turn_id, stream.release)
    }

    fn cancel_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<CancelTurnResponse, HostError> {
        let path = format!("/v1/sessions/{}/cancel", encode_path_segment(session_id));
        let mut response = http_post(self.port, &path, "{}", true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }

        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        let text =
            std::str::from_utf8(&body).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
        let value: Value =
            serde_json::from_str(text).map_err(|_| HostError::sidecar_proxy_protocol_error())?;
        let obj = value
            .as_object()
            .ok_or(HostError::sidecar_proxy_protocol_error())?;
        if obj.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(HostError::sidecar_proxy_protocol_error());
        }

        let _ = turn_id; // turn_id is validated by the caller
        Ok(CancelTurnResponse::ok())
    }
}

impl ConfigBackend for NodeSidecarBackend {
    fn get_config(&self) -> Result<ConfigSnapshotResponse, HostError> {
        let mut response = http_request("GET", self.port, "/v1/config", "", true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_config_snapshot(&body)
    }

    fn create_provider(&self, provider: &Value) -> Result<ProviderConfigResponse, HostError> {
        let body =
            serde_json::to_string(provider).map_err(|_| HostError::invalid_config_request())?;
        let mut response = http_post(self.port, "/v1/providers", &body, true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_provider_config_response(&body)
    }

    fn update_provider(&self, provider: &Value) -> Result<ProviderConfigResponse, HostError> {
        let id = provider
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(HostError::invalid_config_request())?;
        let body =
            serde_json::to_string(provider).map_err(|_| HostError::invalid_config_request())?;
        let path = format!("/v1/providers/{}", encode_path_segment(id));
        let mut response = http_request("PUT", self.port, &path, &body, true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_provider_config_response(&body)
    }

    fn delete_provider(&self, provider_id: &str) -> Result<ConfigDeleteResponse, HostError> {
        let path = format!("/v1/providers/{}", encode_path_segment(provider_id));
        let mut response = http_request("DELETE", self.port, &path, "", true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_config_delete_response(&body)
    }

    fn create_route(&self, route: &Value) -> Result<RouteConfigResponse, HostError> {
        let body = serde_json::to_string(route).map_err(|_| HostError::invalid_config_request())?;
        let mut response = http_post(self.port, "/v1/routes", &body, true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_route_config_response(&body)
    }

    fn update_route(&self, route: &Value) -> Result<RouteConfigResponse, HostError> {
        let id = route
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(HostError::invalid_config_request())?;
        let body = serde_json::to_string(route).map_err(|_| HostError::invalid_config_request())?;
        let path = format!("/v1/routes/{}", encode_path_segment(id));
        let mut response = http_request("PUT", self.port, &path, &body, true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_route_config_response(&body)
    }

    fn delete_route(&self, route_id: &str) -> Result<ConfigDeleteResponse, HostError> {
        let path = format!("/v1/routes/{}", encode_path_segment(route_id));
        let mut response = http_request("DELETE", self.port, &path, "", true)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        let body = response.body.read_to_end(MAX_JSON_BODY_BYTES)?;
        parse_config_delete_response(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[derive(Clone)]
    struct SharedSink {
        events: Arc<Mutex<Vec<(String, String, Value)>>>,
    }

    impl SharedSink {
        fn new() -> Self {
            Self {
                events: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn events(&self) -> Vec<(String, String, Value)> {
            self.events.lock().expect("events lock").clone()
        }
    }

    impl NativeEventSink for SharedSink {
        fn emit(&self, session_id: &str, turn_id: &str, event: &Value) -> Result<(), HostError> {
            self.events.lock().expect("events lock").push((
                session_id.to_string(),
                turn_id.to_string(),
                event.clone(),
            ));
            Ok(())
        }
    }

    fn read_request_headers(stream: &mut std::net::TcpStream) {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 1024];
        while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            let count = stream.read(&mut buffer).expect("request read");
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
    }

    fn spawn_chunked_turn(
        chunks: Vec<Vec<u8>>,
        release_after_first: Option<mpsc::Receiver<()>>,
    ) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("address").port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            read_request_headers(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nx-agent-turn-id: turn-1\r\nConnection: close\r\n\r\n",
                )
                .expect("headers");
            for (index, chunk) in chunks.iter().enumerate() {
                write!(stream, "{:X}\r\n", chunk.len()).expect("chunk header");
                stream.write_all(chunk).expect("chunk body");
                stream.write_all(b"\r\n").expect("chunk delimiter");
                stream.flush().expect("flush");
                if index == 0 {
                    if let Some(release) = release_after_first.as_ref() {
                        let _ = release.recv();
                    }
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        (port, handle)
    }

    fn spawn_headers_only_error() -> (u16, mpsc::Sender<()>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("address").port();
        let (release_sender, release_receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            read_request_headers(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 17825792\r\nConnection: close\r\n\r\n",
                )
                .expect("headers");
            let _ = release_receiver.recv();
        });
        (port, release_sender, handle)
    }

    #[test]
    fn encode_path_segment_encodes_special_characters() {
        assert_eq!(encode_path_segment("abc-123"), "abc-123");
        assert_eq!(encode_path_segment("a/b"), "a%2Fb");
        assert_eq!(encode_path_segment("a b"), "a%20b");
    }

    #[test]
    fn validate_agent_event_accepts_valid_error() {
        let event = serde_json::json!({
            "type": "error",
            "requestId": "turn-1",
            "code": "runner_error",
            "message": "Agent runner failed.",
            "retryable": false
        });
        assert!(validate_agent_event(&event, "turn-1").is_ok());
    }

    #[test]
    fn validate_agent_event_rejects_mismatched_request_id() {
        let event = serde_json::json!({
            "type": "error",
            "requestId": "wrong",
            "code": "runner_error",
            "message": "msg",
            "retryable": false
        });
        assert!(validate_agent_event(&event, "turn-1").is_err());
    }

    #[test]
    fn validate_agent_event_rejects_unknown_type() {
        let event = serde_json::json!({
            "type": "unknown",
            "requestId": "turn-1"
        });
        assert!(validate_agent_event(&event, "turn-1").is_err());
    }

    #[test]
    fn validate_agent_event_rejects_extra_fields() {
        let event = serde_json::json!({
            "type": "completed",
            "requestId": "turn-1",
            "extra": true
        });
        assert!(validate_agent_event(&event, "turn-1").is_err());
    }

    #[test]
    fn is_terminal_event_detects_completed_and_error() {
        assert!(is_terminal_event(&serde_json::json!({"type": "completed"})));
        assert!(is_terminal_event(&serde_json::json!({"type": "error"})));
        assert!(!is_terminal_event(
            &serde_json::json!({"type": "text_delta"})
        ));
    }

    #[test]
    fn parse_session_response_accepts_valid_payload() {
        let body =
            br#"{"session":{"id":"s1","status":"idle","createdAt":1000.0,"updatedAt":1000.0}}"#;
        let response = parse_session_response(body).expect("valid");
        assert_eq!(
            serde_json::to_value(&response).expect("serialize"),
            serde_json::json!({
                "session": {
                    "id": "s1",
                    "status": "idle",
                    "createdAt": 1000.0,
                    "updatedAt": 1000.0
                }
            })
        );
    }

    #[test]
    fn parse_session_response_rejects_unknown_fields() {
        let body = br#"{"session":{"id":"s1","status":"idle","createdAt":1000.0,"updatedAt":1000.0,"extra":true}}"#;
        assert!(parse_session_response(body).is_err());
    }

    #[test]
    fn parse_session_response_rejects_empty_id() {
        let body =
            br#"{"session":{"id":"","status":"idle","createdAt":1000.0,"updatedAt":1000.0}}"#;
        assert!(parse_session_response(body).is_err());
    }

    #[test]
    fn parse_session_response_rejects_non_finite_times() {
        let body =
            br#"{"session":{"id":"s1","status":"idle","createdAt":null,"updatedAt":1000.0}}"#;
        assert!(parse_session_response(body).is_err());
    }

    #[test]
    fn recording_sink_records_events() {
        let sink = RecordingEventSink::new();
        let event = serde_json::json!({"type": "completed", "requestId": "t1"});
        sink.emit("s1", "t1", &event).expect("emit");
        let events = sink.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "s1");
        assert_eq!(events[0].1, "t1");
        assert_eq!(events[0].2, event);
    }

    #[test]
    fn start_turn_returns_after_first_event_without_waiting_for_stream_end() {
        let route = serde_json::json!({
            "type": "route_selected",
            "requestId": "turn-1",
            "routeId": "route-1",
            "model": "model-1"
        });
        let text = serde_json::json!({
            "type": "text_delta",
            "requestId": "turn-1",
            "text": "hello"
        });
        let completed = serde_json::json!({
            "type": "completed",
            "requestId": "turn-1"
        });
        let (release_sender, release_receiver) = mpsc::channel();
        let (port, server) = spawn_chunked_turn(
            vec![
                format!("{}\n", route).into_bytes(),
                format!("{}\n", text).into_bytes(),
                format!("{}\n", completed).into_bytes(),
            ],
            Some(release_receiver),
        );
        let sink = SharedSink::new();
        let backend = Arc::new(NodeSidecarBackend::new(port, Box::new(sink.clone())));
        let (result_sender, result_receiver) = mpsc::channel();
        let request = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        let backend_for_thread = backend.clone();
        thread::spawn(move || {
            let result = backend_for_thread.start_turn("session-1", &request);
            result_sender.send(result).expect("result");
        });

        let response = result_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("start_turn must return after the first event")
            .expect("typed turn response");
        assert_eq!(
            serde_json::to_value(&response).expect("serialize"),
            serde_json::json!({ "turnId": "turn-1" })
        );
        assert!(
            sink.events().is_empty(),
            "first event waits for command return"
        );
        drop(response);

        release_sender.send(()).expect("release stream");
        for _ in 0..20 {
            if sink.events().len() == 3 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let events = sink.events();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].2, route);
        assert_eq!(events[1].2, text);
        assert_eq!(events[2].2, completed);
        server.join().expect("server");
    }

    #[test]
    fn non_success_response_is_returned_without_reading_its_body() {
        let (port, release, server) = spawn_headers_only_error();
        let sink = SharedSink::new();
        let backend = Arc::new(NodeSidecarBackend::new(port, Box::new(sink)));
        let backend_for_thread = backend.clone();
        let (result_sender, result_receiver) = mpsc::channel();
        thread::spawn(move || {
            result_sender
                .send(backend_for_thread.create_session())
                .expect("result");
        });

        let result = result_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("non-success status must not wait for body");
        assert_eq!(result, Err(HostError::sidecar_proxy_http_error()));
        let _ = release.send(());
        server.join().expect("server");
    }

    #[test]
    fn tool_call_input_must_be_an_object_at_the_native_boundary() {
        let event = serde_json::json!({
            "type": "tool_call",
            "requestId": "turn-1",
            "id": "call-1",
            "name": "read_file",
            "input": []
        });
        assert_eq!(
            validate_agent_event(&event, "turn-1"),
            Err(HostError::sidecar_proxy_protocol_error())
        );
    }
}
