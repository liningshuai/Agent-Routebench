//! Fixed host error contract.
//!
//! Every error crossing the IPC boundary is a `HostError` with a fixed code
//! and a fixed message. Messages never embed raw exceptions, stacks, paths,
//! URLs or any part of the request that produced them.

use serde::Serialize;

/// Fixed, stable error codes understood by the Desktop renderer.
pub const HOST_NOT_READY: &str = "host_not_ready";
pub const INVALID_REQUEST: &str = "invalid_request";
pub const INVALID_SESSION_ID: &str = "invalid_session_id";
pub const INVALID_TURN_ID: &str = "invalid_turn_id";
pub const FORBIDDEN_FIELD: &str = "forbidden_field";
#[allow(dead_code)]
pub const INVALID_RESPONSE: &str = "invalid_response";
pub const SIDECAR_START_FAILED: &str = "sidecar_start_failed";
pub const SIDECAR_HEALTH_TIMEOUT: &str = "sidecar_health_timeout";
pub const SIDECAR_NOT_READY: &str = "sidecar_not_ready";
pub const SIDECAR_STOP_FAILED: &str = "sidecar_stop_failed";
pub const INVALID_SIDECAR_OPTIONS: &str = "invalid_sidecar_options";

/// A fixed, serializable host error. Only `code` and `message` are exposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostError {
    pub code: &'static str,
    pub message: &'static str,
}

impl HostError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    /// The Agent backend has not been assembled into this host yet.
    pub const fn host_not_ready() -> Self {
        Self::new(HOST_NOT_READY, "Agent host backend is not ready.")
    }

    /// The request payload failed structural validation.
    pub const fn invalid_request() -> Self {
        Self::new(INVALID_REQUEST, "Agent host request is invalid.")
    }

    /// The session identifier failed validation.
    pub const fn invalid_session_id() -> Self {
        Self::new(INVALID_SESSION_ID, "Agent session id is invalid.")
    }

    /// The turn identifier failed validation.
    pub const fn invalid_turn_id() -> Self {
        Self::new(INVALID_TURN_ID, "Agent turn id is invalid.")
    }

    /// The request carried a credential-like or otherwise forbidden field.
    pub const fn forbidden_field() -> Self {
        Self::new(
            FORBIDDEN_FIELD,
            "Agent host request contains a forbidden field.",
        )
    }

    /// A backend-produced success response failed the fixed response contract.
    /// Consumed by the typed response constructors; the MVP default backend
    /// never fabricates a success.
    #[allow(dead_code)]
    pub const fn invalid_response() -> Self {
        Self::new(INVALID_RESPONSE, "Agent host response is invalid.")
    }

    /// The Node sidecar failed to start.
    pub const fn sidecar_start_failed() -> Self {
        Self::new(SIDECAR_START_FAILED, "Sidecar failed to start.")
    }

    /// The Node sidecar did not become healthy in time.
    pub const fn sidecar_health_timeout() -> Self {
        Self::new(SIDECAR_HEALTH_TIMEOUT, "Sidecar health check timed out.")
    }

    /// The Node sidecar is not ready to accept requests.
    pub const fn sidecar_not_ready() -> Self {
        Self::new(SIDECAR_NOT_READY, "Sidecar is not ready.")
    }

    /// The Node sidecar failed to stop cleanly.
    pub const fn sidecar_stop_failed() -> Self {
        Self::new(SIDECAR_STOP_FAILED, "Sidecar failed to stop.")
    }

    /// The sidecar launch configuration is invalid.
    pub const fn invalid_sidecar_options() -> Self {
        Self::new(INVALID_SIDECAR_OPTIONS, "Sidecar options are invalid.")
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HostError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_not_ready_has_the_fixed_contract() {
        let error = HostError::host_not_ready();
        assert_eq!(error.code, "host_not_ready");
        assert_eq!(error.message, "Agent host backend is not ready.");
    }

    #[test]
    fn every_error_has_a_stable_code_and_short_message() {
        let errors = [
            HostError::host_not_ready(),
            HostError::invalid_request(),
            HostError::invalid_session_id(),
            HostError::invalid_turn_id(),
            HostError::forbidden_field(),
            HostError::invalid_response(),
        ];
        for error in errors {
            assert!(!error.code.is_empty());
            assert!(!error.message.is_empty());
            assert!(error.message.len() < 80);
        }
    }

    #[test]
    fn error_codes_are_unique() {
        let codes = [
            HostError::host_not_ready().code,
            HostError::invalid_request().code,
            HostError::invalid_session_id().code,
            HostError::invalid_turn_id().code,
            HostError::forbidden_field().code,
            HostError::invalid_response().code,
        ];
        for (index, code) in codes.iter().enumerate() {
            assert!(!codes[..index].contains(code));
        }
    }

    #[test]
    fn invalid_response_has_the_fixed_contract() {
        let error = HostError::invalid_response();
        assert_eq!(error.code, "invalid_response");
        assert_eq!(error.message, "Agent host response is invalid.");
    }

    #[test]
    fn error_serializes_to_code_and_message_only() {
        let value = serde_json::to_value(HostError::host_not_ready()).expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 2);
        assert!(object.contains_key("code"));
        assert!(object.contains_key("message"));
    }

    #[test]
    fn error_message_never_embeds_dynamic_content() {
        let error = HostError::forbidden_field();
        assert_eq!(
            error.to_string(),
            "Agent host request contains a forbidden field."
        );
    }
}
