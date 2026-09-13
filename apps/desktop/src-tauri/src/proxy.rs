//! Node sidecar proxy backend.
//!
//! Implements [`HostBackend`] by sending fixed loopback HTTP/1.1 requests to
//! the Node Local Agent Host. Never uses a shell, never binds non-loopback,
//! never leaks paths or raw errors across the IPC boundary.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::Value;

use crate::backend::{
    CancelTurnResponse, CreateSessionResponse, HostBackend, HostSession, HostSessionStatus,
    StartTurnResponse,
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

/// A minimal HTTP/1.1 response parsed from the sidecar.
struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Sends a fixed loopback HTTP/1.1 POST request and reads the full response.
fn http_post(
    port: u16,
    path: &str,
    body: &str,
    close_connection: bool,
) -> Result<HttpResponse, HostError> {
    let addr = format!("{SIDECAR_HOST}:{port}");
    let mut stream =
        TcpStream::connect_timeout(&addr.parse().expect("loopback parse"), CONNECT_TIMEOUT)
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
        "POST {path} HTTP/1.1\r\nHost: {SIDECAR_HOST}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {connection}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;
    stream
        .flush()
        .map_err(|_| HostError::sidecar_proxy_unavailable())?;

    read_http_response(&mut stream)
}

/// Reads a complete HTTP/1.1 response from the stream.
fn read_http_response(stream: &mut TcpStream) -> Result<HttpResponse, HostError> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];

    // Read until we find the end of headers.
    loop {
        let n = stream
            .read(&mut buf)
            .map_err(|_| HostError::sidecar_proxy_unavailable())?;
        if n == 0 {
            return Err(HostError::sidecar_proxy_unavailable());
        }
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > MAX_HEADER_BYTES + MAX_JSON_BODY_BYTES {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
        if let Some(pos) = find_header_end(&raw) {
            return parse_response(&raw, pos, stream);
        }
    }
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_response(
    raw: &[u8],
    header_end: usize,
    stream: &mut TcpStream,
) -> Result<HttpResponse, HostError> {
    let header_text = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or(HostError::sidecar_proxy_protocol_error())?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or(HostError::sidecar_proxy_protocol_error())?;

    let mut headers = Vec::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.push((key.trim().to_lowercase(), value.trim().to_string()));
        }
    }

    let body_start = header_end + 4;
    let initial_body = raw[body_start..].to_vec();

    let content_length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok());

    let is_chunked = headers
        .iter()
        .find(|(k, _)| k == "transfer-encoding")
        .map(|(_, v)| v.to_lowercase().contains("chunked"))
        .unwrap_or(false);

    let body = if is_chunked {
        read_chunked_body(stream, initial_body)?
    } else if let Some(len) = content_length {
        read_fixed_body(stream, initial_body, len)?
    } else {
        read_until_eof(stream, initial_body)?
    };

    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

fn read_fixed_body(
    stream: &mut TcpStream,
    mut body: Vec<u8>,
    content_length: usize,
) -> Result<Vec<u8>, HostError> {
    if content_length > MAX_JSON_BODY_BYTES {
        return Err(HostError::sidecar_proxy_protocol_error());
    }
    let mut buf = [0u8; 4096];
    while body.len() < content_length {
        let n = stream
            .read(&mut buf)
            .map_err(|_| HostError::sidecar_proxy_unavailable())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(content_length);
    Ok(body)
}

fn read_chunked_body(stream: &mut TcpStream, mut body: Vec<u8>) -> Result<Vec<u8>, HostError> {
    let mut buf = [0u8; 4096];
    let mut total = 0usize;
    loop {
        // Find the end of the current chunk header.
        let chunk_header_end = body
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or(HostError::sidecar_proxy_protocol_error())?;
        let chunk_header = std::str::from_utf8(&body[..chunk_header_end])
            .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
        let chunk_size = usize::from_str_radix(chunk_header.trim(), 16)
            .map_err(|_| HostError::sidecar_proxy_protocol_error())?;

        if chunk_size == 0 {
            return Ok(Vec::new());
        }

        total += chunk_size;
        if total > MAX_NDJSON_TOTAL_BYTES {
            return Err(HostError::sidecar_proxy_protocol_error());
        }

        // We need chunk_size + 2 bytes (\r\n) after the header.
        let needed = chunk_header_end + 2 + chunk_size + 2;
        while body.len() < needed {
            let n = stream
                .read(&mut buf)
                .map_err(|_| HostError::sidecar_proxy_unavailable())?;
            if n == 0 {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            body.extend_from_slice(&buf[..n]);
        }

        // For streaming we return just the chunk data; the caller handles NDJSON.
        let data_start = chunk_header_end + 2;
        let data_end = data_start + chunk_size;
        return Ok(body[data_start..data_end].to_vec());
    }
}

fn read_until_eof(stream: &mut TcpStream, mut body: Vec<u8>) -> Result<Vec<u8>, HostError> {
    let mut buf = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut buf)
            .map_err(|_| HostError::sidecar_proxy_unavailable())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
        if body.len() > MAX_JSON_BODY_BYTES {
            return Err(HostError::sidecar_proxy_protocol_error());
        }
    }
    Ok(body)
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
                || obj.get("input").is_none()
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

/// The production Node sidecar proxy backend.
pub struct NodeSidecarBackend {
    port: u16,
    sink: Box<dyn NativeEventSink>,
}

impl NodeSidecarBackend {
    pub fn new(port: u16, sink: Box<dyn NativeEventSink>) -> Self {
        Self { port, sink }
    }

    /// Reads NDJSON events from a chunked/Content-Length response body and
    /// emits them through the sink. Returns after the first terminal event
    /// or EOF.
    fn stream_ndjson_events(
        &self,
        session_id: &str,
        turn_id: &str,
        body: Vec<u8>,
    ) -> Result<(), HostError> {
        let text = String::from_utf8(body).map_err(|_| {
            // Invalid UTF-8: emit a fixed safe error and stop.
            let _ = self.sink.emit(
                session_id,
                turn_id,
                &serde_json::json!({
                    "type": "error",
                    "requestId": turn_id,
                    "code": "gateway_error",
                    "message": "Model gateway request failed.",
                    "retryable": false,
                }),
            );
            HostError::sidecar_proxy_protocol_error()
        });

        let text = match text {
            Ok(t) => t,
            Err(error) => return Err(error),
        };

        let mut saw_terminal = false;
        let mut total_bytes = 0usize;

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            total_bytes += line.len();
            if total_bytes > MAX_NDJSON_TOTAL_BYTES {
                return Err(HostError::sidecar_proxy_protocol_error());
            }
            if line.len() > MAX_NDJSON_LINE_BYTES {
                return Err(HostError::sidecar_proxy_protocol_error());
            }

            let event: Value = serde_json::from_str(line).map_err(|_| {
                let _ = self.sink.emit(
                    session_id,
                    turn_id,
                    &serde_json::json!({
                        "type": "error",
                        "requestId": turn_id,
                        "code": "gateway_error",
                        "message": "Model gateway request failed.",
                        "retryable": false,
                    }),
                );
                HostError::sidecar_proxy_protocol_error()
            })?;

            validate_agent_event(&event, turn_id)?;

            if saw_terminal {
                return Err(HostError::sidecar_proxy_protocol_error());
            }

            self.sink.emit(session_id, turn_id, &event)?;

            if is_terminal_event(&event) {
                saw_terminal = true;
            }
        }

        if !saw_terminal {
            // EOF without a terminal event: emit a fixed safe error.
            self.sink.emit(
                session_id,
                turn_id,
                &serde_json::json!({
                    "type": "error",
                    "requestId": turn_id,
                    "code": "gateway_error",
                    "message": "Model gateway request failed.",
                    "retryable": false,
                }),
            )?;
        }

        Ok(())
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
        let response = http_post(self.port, "/v1/sessions", "{}", false)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }
        parse_session_response(&response.body)
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

        // Stream events in the background after returning the turnId.
        // For the synchronous HostBackend trait, we stream inline after
        // extracting the turnId. The Tauri command returns the turnId;
        // events are emitted during this call.
        self.stream_ndjson_events(session_id, &turn_id, response.body)?;

        StartTurnResponse::new(turn_id)
    }

    fn cancel_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<CancelTurnResponse, HostError> {
        let path = format!("/v1/sessions/{}/cancel", encode_path_segment(session_id));
        let response = http_post(self.port, &path, "{}", false)?;
        if response.status < 200 || response.status >= 300 {
            return Err(HostError::sidecar_proxy_http_error());
        }

        let text = std::str::from_utf8(&response.body)
            .map_err(|_| HostError::sidecar_proxy_protocol_error())?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
