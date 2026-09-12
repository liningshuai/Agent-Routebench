//! The fixed `agent_*` IPC commands of the Tauri native host.
//!
//! Task 19 keeps the Task 18 IPC contract byte-for-byte and routes every
//! backend-shaped command through the injectable [`HostRuntime`]. The
//! delegation order is fixed: validate first, then consult the runtime's
//! backend. With the production default (`NotReadyBackend`) every
//! backend-shaped command still answers with the fixed `host_not_ready`
//! error; nothing is fabricated.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::backend::{CancelTurnResponse, CreateSessionResponse, StartTurnResponse};
use crate::errors::HostError;
use crate::runtime::HostRuntime;
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

/// Reports that the native host process is up. Deliberately takes no state:
/// host health never reads the backend, providers or the network.
#[tauri::command]
pub fn agent_health() -> HostHealth {
    HostHealth {
        ok: true,
        service: HOST_SERVICE,
        version: HOST_VERSION,
    }
}

/// Creates an agent session. The success value is the closed
/// `CreateSessionResponse` contract (`{ "session": { … } }`); with the
/// NotReadyBackend default this answers the fixed host_not_ready error and
/// fabricates no session.
#[tauri::command]
pub fn agent_create_session(
    runtime: State<HostRuntime>,
) -> Result<CreateSessionResponse, HostError> {
    // With the NotReadyBackend default this answers the fixed host_not_ready
    // error; no session is ever fabricated here.
    create_session_checked(&runtime)
}

fn create_session_checked(runtime: &HostRuntime) -> Result<CreateSessionResponse, HostError> {
    runtime.backend().create_session()
}

/// Starts a turn. The session id and the whole request payload are validated
/// first; the backend is consulted only afterwards. With the NotReadyBackend
/// default this answers the fixed host_not_ready error and fabricates no
/// turn id and no streaming event.
#[tauri::command]
pub fn agent_start_turn(
    session_id: String,
    request: Value,
    runtime: State<HostRuntime>,
) -> Result<StartTurnResponse, HostError> {
    // Validation runs strictly before the backend; with the NotReadyBackend
    // default this answers the fixed host_not_ready error and fabricates no
    // turn id and no streaming event. The success value is the closed
    // `StartTurnResponse` contract (`{ "turnId": … }`); the raw request is
    // never echoed back.
    start_turn_checked(&runtime, &session_id, &request)
}

fn start_turn_checked(
    runtime: &HostRuntime,
    session_id: &str,
    request: &Value,
) -> Result<StartTurnResponse, HostError> {
    validation::validate_start_turn_payload(session_id, request)?;
    runtime.backend().start_turn(session_id, request)
}

/// Cancels a turn. Both identifiers are validated first; the backend is
/// consulted only afterwards. With the NotReadyBackend default this answers
/// the fixed host_not_ready error instead of inventing a cancellation.
#[tauri::command]
pub fn agent_cancel_turn(
    session_id: String,
    turn_id: String,
    runtime: State<HostRuntime>,
) -> Result<CancelTurnResponse, HostError> {
    cancel_turn_checked(&runtime, &session_id, &turn_id)
}

fn cancel_turn_checked(
    runtime: &HostRuntime,
    session_id: &str,
    turn_id: &str,
) -> Result<CancelTurnResponse, HostError> {
    validation::validate_session_id(session_id)?;
    validation::validate_turn_id(turn_id)?;
    runtime.backend().cancel_turn(session_id, turn_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::Mutex;

    /// Test-only recording fake; never a production default.
    struct RecordingBackend {
        calls: Mutex<Vec<&'static str>>,
        error: HostError,
    }

    impl RecordingBackend {
        fn failing() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                error: HostError::invalid_request(),
            }
        }

        fn not_ready() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                error: HostError::host_not_ready(),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().expect("lock").clone()
        }
    }

    impl crate::backend::HostBackend for RecordingBackend {
        fn create_session(&self) -> Result<CreateSessionResponse, HostError> {
            self.calls.lock().expect("lock").push("create_session");
            Err(self.error.clone())
        }

        fn start_turn(
            &self,
            _session_id: &str,
            _request: &Value,
        ) -> Result<StartTurnResponse, HostError> {
            self.calls.lock().expect("lock").push("start_turn");
            Err(self.error.clone())
        }

        fn cancel_turn(
            &self,
            _session_id: &str,
            _turn_id: &str,
        ) -> Result<CancelTurnResponse, HostError> {
            self.calls.lock().expect("lock").push("cancel_turn");
            Err(self.error.clone())
        }
    }

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
    fn create_session_with_the_default_runtime_is_host_not_ready() {
        let runtime = HostRuntime::not_ready();
        assert_eq!(
            create_session_checked(&runtime),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn create_session_delegates_to_the_injected_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            create_session_checked(&runtime),
            Err(HostError::invalid_request())
        );
        assert_eq!(backend.calls(), vec!["create_session"]);
    }

    #[test]
    fn start_turn_with_valid_payload_delegates_to_the_backend() {
        let backend = Arc::new(RecordingBackend::not_ready());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            start_turn_checked(&runtime, "session-1", &valid_request()),
            Err(HostError::host_not_ready())
        );
        assert_eq!(backend.calls(), vec!["start_turn"]);
    }

    #[test]
    fn start_turn_rejects_invalid_session_ids_before_the_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            start_turn_checked(&runtime, "", &valid_request()),
            Err(HostError::invalid_session_id())
        );
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn start_turn_rejects_forbidden_fields_before_the_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        let request = json!({
            "messages": valid_request()["messages"],
            "apiKey": "value"
        });
        assert_eq!(
            start_turn_checked(&runtime, "session-1", &request),
            Err(HostError::forbidden_field())
        );
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn start_turn_rejects_unknown_fields_before_the_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        let request = json!({
            "messages": valid_request()["messages"],
            "extra": true
        });
        assert_eq!(
            start_turn_checked(&runtime, "session-1", &request),
            Err(HostError::invalid_request())
        );
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn start_turn_rejects_invalid_messages_before_the_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            start_turn_checked(&runtime, "session-1", &json!({ "messages": [] })),
            Err(HostError::invalid_request())
        );
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn cancel_turn_with_valid_ids_delegates_to_the_backend() {
        let backend = Arc::new(RecordingBackend::not_ready());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            cancel_turn_checked(&runtime, "session-1", "turn-1"),
            Err(HostError::host_not_ready())
        );
        assert_eq!(backend.calls(), vec!["cancel_turn"]);
    }

    #[test]
    fn cancel_turn_rejects_invalid_session_ids_before_the_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            cancel_turn_checked(&runtime, "", "turn-1"),
            Err(HostError::invalid_session_id())
        );
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn cancel_turn_rejects_invalid_turn_ids_before_the_backend() {
        let backend = Arc::new(RecordingBackend::failing());
        let runtime = HostRuntime::with_backend(backend.clone());
        assert_eq!(
            cancel_turn_checked(&runtime, "session-1", " "),
            Err(HostError::invalid_turn_id())
        );
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn backend_failures_collapse_to_their_fixed_contract() {
        let runtime = HostRuntime::with_backend(Arc::new(RecordingBackend::failing()));
        let error = cancel_turn_checked(&runtime, "session-1", "turn-1").expect_err("fixed");
        assert_eq!(error.code, "invalid_request");
        assert_eq!(error.message, "Agent host request is invalid.");
    }

    #[test]
    fn repeated_commands_leave_no_global_trace() {
        let backend = Arc::new(RecordingBackend::failing());
        {
            let runtime = HostRuntime::with_backend(backend.clone());
            let _ = create_session_checked(&runtime);
            let _ = create_session_checked(&runtime);
        }
        let fresh = HostRuntime::with_backend(Arc::new(RecordingBackend::failing()));
        assert_eq!(
            create_session_checked(&fresh),
            Err(HostError::invalid_request())
        );
        assert_eq!(backend.calls().len(), 2);
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

    #[test]
    fn not_ready_backend_default_survives_thread_offloading() {
        // HostBackend: Send + Sync keeps the runtime usable from Tauri's
        // multi-threaded IPC dispatch.
        let runtime = Arc::new(HostRuntime::not_ready());
        let handle = std::thread::spawn(move || runtime.backend().create_session());
        assert_eq!(
            handle.join().expect("join"),
            Err(HostError::host_not_ready())
        );
    }
}
