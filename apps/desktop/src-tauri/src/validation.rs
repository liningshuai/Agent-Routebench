//! Structural request validation for the fixed host commands.
//!
//! Validation is pure, input-sized and fails closed. It never executes
//! anything, never reads the environment and never inspects the network.
//! Every rejection maps to one of the fixed `HostError` constructors.

use serde_json::Value;

use crate::errors::HostError;

const MAX_ID_LEN: usize = 128;
const MAX_MESSAGES: usize = 256;
const MAX_TOOLS: usize = 64;
const MAX_ROUTE_ID_LEN: usize = 128;
const MAX_MODEL_LEN: usize = 128;
const MAX_TOKENS: u64 = 4_000_000;

/// Fields that must never appear in a turn request, regardless of position.
const FORBIDDEN_FIELDS: [&str; 11] = [
    "apiKey",
    "api_key",
    "token",
    "authorization",
    "Authorization",
    "headers",
    "secret",
    "password",
    "credential",
    "baseUrl",
    "endpoint",
];

/// The only fields a turn request may carry.
const TURN_FIELDS: [&str; 5] = ["messages", "tools", "routeId", "model", "maxTokens"];

const MESSAGE_ROLES: [&str; 4] = ["user", "assistant", "system", "tool"];

/// Validates an identifier-shaped string: non-empty, bounded, printable ASCII.
fn validate_identifier(value: &str, kind: fn() -> HostError) -> Result<(), HostError> {
    if value.is_empty() || value.len() > MAX_ID_LEN {
        return Err(kind());
    }
    if !value.chars().all(|c| c.is_ascii_graphic()) {
        return Err(kind());
    }
    Ok(())
}

/// Validates a session identifier supplied over IPC.
pub fn validate_session_id(value: &str) -> Result<(), HostError> {
    validate_identifier(value, HostError::invalid_session_id)
}

/// Validates a turn identifier supplied over IPC.
pub fn validate_turn_id(value: &str) -> Result<(), HostError> {
    validate_identifier(value, HostError::invalid_turn_id)
}

/// Validates the `messages` array of a turn request.
pub fn validate_messages(value: &Value) -> Result<(), HostError> {
    let items = value.as_array().ok_or_else(HostError::invalid_request)?;
    if items.is_empty() || items.len() > MAX_MESSAGES {
        return Err(HostError::invalid_request());
    }
    for item in items {
        let message = item.as_object().ok_or_else(HostError::invalid_request)?;
        if message.len() != 2 {
            return Err(HostError::invalid_request());
        }
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(HostError::invalid_request)?;
        if !MESSAGE_ROLES.contains(&role) {
            return Err(HostError::invalid_request());
        }
        validate_message_content(
            message
                .get("content")
                .ok_or_else(HostError::invalid_request)?,
        )?;
    }
    Ok(())
}

fn validate_message_content(content: &Value) -> Result<(), HostError> {
    match content {
        Value::String(_) => Ok(()),
        Value::Array(blocks) => {
            if blocks.is_empty() {
                return Err(HostError::invalid_request());
            }
            for block in blocks {
                let block = block.as_object().ok_or_else(HostError::invalid_request)?;
                if block.get("type").and_then(Value::as_str).is_none() {
                    return Err(HostError::invalid_request());
                }
            }
            Ok(())
        }
        _ => Err(HostError::invalid_request()),
    }
}

/// Validates the optional `tools` array of a turn request.
pub fn validate_tools(value: &Value) -> Result<(), HostError> {
    let items = value.as_array().ok_or_else(HostError::invalid_request)?;
    if items.len() > MAX_TOOLS {
        return Err(HostError::invalid_request());
    }
    for item in items {
        let tool = item.as_object().ok_or_else(HostError::invalid_request)?;
        if tool.len() > 3 {
            return Err(HostError::invalid_request());
        }
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(HostError::invalid_request)?;
        if name.is_empty() || name.len() > MAX_ID_LEN {
            return Err(HostError::invalid_request());
        }
        if let Some(description) = tool.get("description") {
            if description.as_str().is_none() {
                return Err(HostError::invalid_request());
            }
        }
        if let Some(schema) = tool.get("inputSchema") {
            if !schema.is_object() {
                return Err(HostError::invalid_request());
            }
        }
    }
    Ok(())
}

/// Validates the optional `maxTokens` field of a turn request.
pub fn validate_max_tokens(value: &Value) -> Result<(), HostError> {
    match value.as_u64() {
        Some(tokens) if tokens > 0 && tokens <= MAX_TOKENS => Ok(()),
        _ => Err(HostError::invalid_request()),
    }
}

fn validate_optional_id(value: Option<&Value>, max: usize) -> Result<(), HostError> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(text)) => {
            if text.is_empty() || text.len() > max {
                Err(HostError::invalid_request())
            } else {
                Ok(())
            }
        }
        _ => Err(HostError::invalid_request()),
    }
}

/// Validates the full `agent_start_turn` request payload.
///
/// `session_id` is the identifier argument; `request` is the turn request
/// object. Sensitive fields are rejected first, then unknown fields, then
/// the remaining fields are validated individually.
pub fn validate_start_turn_payload(session_id: &str, request: &Value) -> Result<(), HostError> {
    validate_session_id(session_id)?;
    let request = request.as_object().ok_or_else(HostError::invalid_request)?;

    for key in request.keys() {
        if FORBIDDEN_FIELDS.contains(&key.as_str()) {
            return Err(HostError::forbidden_field());
        }
    }
    for key in request.keys() {
        if !TURN_FIELDS.contains(&key.as_str()) {
            return Err(HostError::invalid_request());
        }
    }

    if let Some(messages) = request.get("messages") {
        validate_messages(messages)?;
    } else {
        return Err(HostError::invalid_request());
    }
    if let Some(tools) = request.get("tools") {
        if !tools.is_null() {
            validate_tools(tools)?;
        }
    }
    if let Some(max_tokens) = request.get("maxTokens") {
        if !max_tokens.is_null() {
            validate_max_tokens(max_tokens)?;
        }
    }
    validate_optional_id(request.get("routeId"), MAX_ROUTE_ID_LEN)?;
    validate_optional_id(request.get("model"), MAX_MODEL_LEN)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_request() -> Value {
        json!({
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        })
    }

    #[test]
    fn accepts_a_minimal_valid_payload() {
        assert_eq!(
            validate_start_turn_payload("session-1", &valid_request()),
            Ok(())
        );
    }

    #[test]
    fn rejects_blank_and_oversized_session_ids() {
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("   ").is_err());
        assert!(validate_session_id(&"a".repeat(MAX_ID_LEN + 1)).is_err());
        assert!(validate_session_id("session-1").is_ok());
    }

    #[test]
    fn rejects_control_characters_in_identifiers() {
        assert!(validate_session_id("session\n1").is_err());
        assert!(validate_turn_id("turn\t1").is_err());
        assert!(validate_turn_id("turn-1").is_ok());
    }

    #[test]
    fn rejects_every_forbidden_field() {
        for field in FORBIDDEN_FIELDS {
            let mut request = valid_request();
            request
                .as_object_mut()
                .expect("object")
                .insert(field.to_string(), json!("value"));
            assert_eq!(
                validate_start_turn_payload("session-1", &request),
                Err(HostError::forbidden_field()),
                "field {field} must be rejected as forbidden"
            );
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let mut request = valid_request();
        request
            .as_object_mut()
            .expect("object")
            .insert("surprise".to_string(), json!(true));
        assert_eq!(
            validate_start_turn_payload("session-1", &request),
            Err(HostError::invalid_request())
        );
    }

    #[test]
    fn rejects_non_object_requests() {
        assert_eq!(
            validate_start_turn_payload("session-1", &json!([1, 2])),
            Err(HostError::invalid_request())
        );
        assert_eq!(
            validate_start_turn_payload("session-1", &json!("text")),
            Err(HostError::invalid_request())
        );
    }

    #[test]
    fn rejects_invalid_session_ids_before_request_validation() {
        assert_eq!(
            validate_start_turn_payload("", &valid_request()),
            Err(HostError::invalid_session_id())
        );
    }

    #[test]
    fn rejects_invalid_messages() {
        for messages in [
            json!("text"),
            json!([]),
            json!([1]),
            json!([{ "role": "user" }]),
            json!([{ "role": "wizard", "content": "hi" }]),
            json!([{ "role": "user", "content": "hi", "extra": 1 }]),
            json!([{ "role": "user", "content": 42 }]),
        ] {
            let request = json!({ "messages": messages });
            assert_eq!(
                validate_start_turn_payload("session-1", &request),
                Err(HostError::invalid_request()),
                "messages {messages} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_structured_content_blocks() {
        let request = json!({
            "messages": [
                {
                    "role": "user",
                    "content": [{ "type": "text", "text": "hello" }]
                }
            ]
        });
        assert_eq!(validate_start_turn_payload("session-1", &request), Ok(()));
    }

    #[test]
    fn rejects_invalid_tools() {
        for tools in [
            json!("grep"),
            json!([{ "description": "no name" }]),
            json!([{ "name": "" }]),
            json!([{ "name": 42 }]),
            json!([{ "name": "grep", "inputSchema": "nope" }]),
        ] {
            let request = json!({ "messages": valid_request()["messages"], "tools": tools });
            assert_eq!(
                validate_start_turn_payload("session-1", &request),
                Err(HostError::invalid_request()),
                "tools {tools} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_valid_tools() {
        let request = json!({
            "messages": valid_request()["messages"],
            "tools": [
                { "name": "grep", "description": "search", "inputSchema": { "type": "object" } }
            ]
        });
        assert_eq!(validate_start_turn_payload("session-1", &request), Ok(()));
    }

    #[test]
    fn rejects_invalid_max_tokens() {
        for max_tokens in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("many"),
            json!(MAX_TOKENS + 1),
        ] {
            let request = json!({
                "messages": valid_request()["messages"],
                "maxTokens": max_tokens
            });
            assert_eq!(
                validate_start_turn_payload("session-1", &request),
                Err(HostError::invalid_request()),
                "maxTokens {max_tokens} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_positive_max_tokens() {
        let request = json!({
            "messages": valid_request()["messages"],
            "maxTokens": 1024
        });
        assert_eq!(validate_start_turn_payload("session-1", &request), Ok(()));
    }

    #[test]
    fn rejects_oversized_route_ids_and_models() {
        let request = json!({
            "messages": valid_request()["messages"],
            "routeId": "x".repeat(MAX_ROUTE_ID_LEN + 1)
        });
        assert_eq!(
            validate_start_turn_payload("session-1", &request),
            Err(HostError::invalid_request())
        );
        let request = json!({
            "messages": valid_request()["messages"],
            "model": 7
        });
        assert_eq!(
            validate_start_turn_payload("session-1", &request),
            Err(HostError::invalid_request())
        );
    }
}
