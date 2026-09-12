//! The fixed `agent_*` IPC commands of the Tauri native host.
//!
//! Task 18 ships the host shell only. There is no Agent backend behind these
//! commands yet, so every backend-dependent command answers with the fixed
//! `host_not_ready` error. No session, turn, event or model response is ever
//! fabricated here.

use serde::Serialize;
use serde_json::Value;

use crate::errors::HostError;
use crate::validation;

/// Reserved streaming event name. The contract is fixed so the Desktop
/// renderer bridge stays stable; the MVP host never publishes this event.
/// The Task 21 backend assembly will emit it; until then it is deliberately
/// unused.
#[allow(dead_code)]
pub const TURN_EVENT: &str = "agent_turn_event";

/// Fixed identity of the native host process reported by `agent_health`.
pub const HOST_SERVICE: &str = "agent-workbench-tauri-host";
pub const HOST_VERSION: u32 = 1;

/// Health payload of the native host process itself. It says nothing about
/// providers, backends or network reachability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostHealth {
    pub ok: bool,
    pub service: &'static str,
    pub version: u32,
}

/// Reports that the native host process is up.
#[tauri::command]
pub fn agent_health() -> HostHealth {
    HostHealth {
        ok: true,
        service: HOST_SERVICE,
        version: HOST_VERSION,
    }
}

/// Creates an agent session. The backend is not assembled in Task 18, so this
/// always answers with the fixed `host_not_ready` error.
#[tauri::command]
pub fn agent_create_session() -> Result<Value, HostError> {
    Err(HostError::host_not_ready())
}

/// Starts a turn. The payload is fully validated first; without a backend the
/// command then answers with the fixed `host_not_ready` error. No turn
/// identifier and no streaming event is fabricated.
#[tauri::command]
pub fn agent_start_turn(session_id: String, request: Value) -> Result<Value, HostError> {
    validation::validate_start_turn_payload(&session_id, &request)?;
    Err(HostError::host_not_ready())
}

/// Cancels a turn. Both identifiers are validated; without a backend there is
/// nothing to cancel, so the command answers with the fixed `host_not_ready`
/// error instead of inventing a successful cancellation.
#[tauri::command]
pub fn agent_cancel_turn(session_id: String, turn_id: String) -> Result<Value, HostError> {
    validation::validate_session_id(&session_id)?;
    validation::validate_turn_id(&turn_id)?;
    Err(HostError::host_not_ready())
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
    fn health_reports_only_the_host_process() {
        let health = agent_health();
        assert!(health.ok);
        assert_eq!(health.service, "agent-workbench-tauri-host");
        assert_eq!(health.version, 1);
    }

    #[test]
    fn health_payload_never_claims_a_backend_or_provider_connection() {
        let value = serde_json::to_value(agent_health()).expect("serialize");
        let raw = serde_json::to_string(&value).expect("string");
        assert!(!raw.contains("provider"));
        assert!(!raw.contains("backend"));
        assert!(!raw.contains("model"));
    }

    #[test]
    fn create_session_is_always_host_not_ready() {
        assert_eq!(agent_create_session(), Err(HostError::host_not_ready()));
    }

    #[test]
    fn start_turn_with_valid_payload_is_host_not_ready() {
        assert_eq!(
            agent_start_turn(String::from("session-1"), valid_request()),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn start_turn_rejects_forbidden_fields_before_the_backend_check() {
        let request = json!({
            "messages": valid_request()["messages"],
            "apiKey": "value"
        });
        assert_eq!(
            agent_start_turn(String::from("session-1"), request),
            Err(HostError::forbidden_field())
        );
    }

    #[test]
    fn start_turn_rejects_unknown_fields() {
        let request = json!({
            "messages": valid_request()["messages"],
            "extra": true
        });
        assert_eq!(
            agent_start_turn(String::from("session-1"), request),
            Err(HostError::invalid_request())
        );
    }

    #[test]
    fn start_turn_rejects_invalid_session_ids() {
        assert_eq!(
            agent_start_turn(String::new(), valid_request()),
            Err(HostError::invalid_session_id())
        );
    }

    #[test]
    fn start_turn_rejects_invalid_messages() {
        assert_eq!(
            agent_start_turn(String::from("session-1"), json!({ "messages": [] })),
            Err(HostError::invalid_request())
        );
    }

    #[test]
    fn cancel_turn_with_valid_ids_is_host_not_ready() {
        assert_eq!(
            agent_cancel_turn(String::from("session-1"), String::from("turn-1")),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn cancel_turn_rejects_invalid_session_ids() {
        assert_eq!(
            agent_cancel_turn(String::new(), String::from("turn-1")),
            Err(HostError::invalid_session_id())
        );
    }

    #[test]
    fn cancel_turn_rejects_invalid_turn_ids() {
        assert_eq!(
            agent_cancel_turn(String::from("session-1"), String::new()),
            Err(HostError::invalid_turn_id())
        );
    }

    #[test]
    fn turn_event_name_matches_the_fixed_renderer_contract() {
        assert_eq!(TURN_EVENT, "agent_turn_event");
    }

    #[test]
    fn host_identity_is_stable() {
        assert_eq!(HOST_SERVICE, "agent-workbench-tauri-host");
        assert_eq!(HOST_VERSION, 1);
    }
}
