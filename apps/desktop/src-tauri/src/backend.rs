//! The injectable backend boundary of the Tauri native host.
//!
//! Task 19 introduces the seam only. There is no real Agent backend yet: the
//! production default is [`NotReadyBackend`], which fails every backend-shaped
//! request with the fixed `host_not_ready` error. A later task will supply a
//! real implementation through explicit injection, without changing the IPC
//! contract.
//!
//! The trait's error type is the fixed [`HostError`] contract, so dynamic
//! exception text, paths, network addresses or hidden values are
//! unrepresentable at this boundary by construction.

use crate::errors::HostError;

/// A pluggable Agent backend behind the fixed IPC commands.
///
/// Implementations are wired in through [`crate::runtime::HostRuntime`] and
/// must remain offline in the MVP: no upstream model access, no hidden
/// values, no network and no child processes.
pub trait HostBackend: Send + Sync {
    fn create_session(&self) -> Result<serde_json::Value, HostError>;

    fn start_turn(
        &self,
        session_id: &str,
        request: &serde_json::Value,
    ) -> Result<serde_json::Value, HostError>;

    fn cancel_turn(&self, session_id: &str, turn_id: &str) -> Result<serde_json::Value, HostError>;
}

/// Production default backend.
///
/// The Agent backend has not been assembled yet, so every operation answers
/// with the fixed `host_not_ready` error. Nothing is fabricated: no session,
/// no turn id, no streaming event.
pub struct NotReadyBackend;

impl HostBackend for NotReadyBackend {
    fn create_session(&self) -> Result<serde_json::Value, HostError> {
        Err(HostError::host_not_ready())
    }

    fn start_turn(
        &self,
        _session_id: &str,
        _request: &serde_json::Value,
    ) -> Result<serde_json::Value, HostError> {
        Err(HostError::host_not_ready())
    }

    fn cancel_turn(
        &self,
        _session_id: &str,
        _turn_id: &str,
    ) -> Result<serde_json::Value, HostError> {
        Err(HostError::host_not_ready())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn not_ready_backend_fails_create_session_with_the_fixed_error() {
        assert_eq!(
            NotReadyBackend.create_session(),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn not_ready_backend_fails_start_turn_with_the_fixed_error() {
        let request = json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        assert_eq!(
            NotReadyBackend.start_turn("session-1", &request),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn not_ready_backend_fails_cancel_turn_with_the_fixed_error() {
        assert_eq!(
            NotReadyBackend.cancel_turn("session-1", "turn-1"),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn not_ready_backend_error_payload_is_stable() {
        let error = NotReadyBackend.create_session().expect_err("not ready");
        assert_eq!(error.code, "host_not_ready");
        assert_eq!(error.message, "Agent host backend is not ready.");
    }

    #[test]
    fn not_ready_backend_never_fabricates_a_session_or_turn() {
        let request = json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        assert!(NotReadyBackend.create_session().is_err());
        assert!(NotReadyBackend.start_turn("session-1", &request).is_err());
        assert!(NotReadyBackend.cancel_turn("session-1", "turn-1").is_err());
    }
}
