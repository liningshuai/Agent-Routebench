//! The injectable backend boundary of the Tauri native host.
//!
//! Task 19 introduces the seam only. There is no real Agent backend yet: the
//! production default is [`NotReadyBackend`], which fails every backend-shaped
//! request with the fixed `host_not_ready` error. A later task will supply a
//! real implementation through explicit injection, without changing the IPC
//! contract.
//!
//! The trait's error type is the fixed [`HostError`] contract, and every
//! success value is a command-specific closed struct, so dynamic exception
//! text, paths, network addresses or hidden values are unrepresentable at
//! this boundary by construction. The raw `serde_json::Value` type only
//! appears as the already-validated `start_turn` request input; it can never
//! become an open success output.

use serde::Serialize;
use std::sync::mpsc;

use crate::errors::HostError;

/// Closed set of session lifecycle states reported over the IPC boundary.
/// Constructors are consumed by the future backend assembly (Task 21) and by
/// tests; the MVP host itself never fabricates a session.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSessionStatus {
    Idle,
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// A session as exposed over the fixed IPC contract.
///
/// Fields are private and can only be produced through the validated
/// [`HostSession::new`] constructor. `active_turn_id` is omitted from the
/// serialized form when unset, never serialized as null.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSession {
    id: String,
    status: HostSessionStatus,
    created_at: f64,
    updated_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_turn_id: Option<String>,
}

#[allow(dead_code)]
impl HostSession {
    /// Builds a session payload, rejecting empty identifiers and non-finite
    /// timestamps with the fixed `invalid_response` error.
    pub fn new(
        id: String,
        status: HostSessionStatus,
        created_at: f64,
        updated_at: f64,
        active_turn_id: Option<String>,
    ) -> Result<Self, HostError> {
        if id.is_empty() {
            return Err(HostError::invalid_response());
        }
        if !created_at.is_finite() || !updated_at.is_finite() {
            return Err(HostError::invalid_response());
        }
        if let Some(turn) = &active_turn_id {
            if turn.is_empty() {
                return Err(HostError::invalid_response());
            }
        }
        Ok(Self {
            id,
            status,
            created_at,
            updated_at,
            active_turn_id,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn status(&self) -> HostSessionStatus {
        self.status
    }
}

/// Success payload of `agent_create_session`: exactly one `session` wrapper.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreateSessionResponse {
    session: HostSession,
}

#[allow(dead_code)]
impl CreateSessionResponse {
    pub fn new(session: HostSession) -> Self {
        Self { session }
    }
}

/// Success payload of `agent_start_turn`: exactly one `turnId` field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnResponse {
    turn_id: String,
    #[serde(skip)]
    stream_release: Option<mpsc::Sender<()>>,
}

impl PartialEq for StartTurnResponse {
    fn eq(&self, other: &Self) -> bool {
        self.turn_id == other.turn_id
    }
}

impl Eq for StartTurnResponse {}

#[allow(dead_code)]
impl StartTurnResponse {
    /// Builds the turn response, rejecting empty turn identifiers.
    pub fn new(turn_id: String) -> Result<Self, HostError> {
        if turn_id.is_empty() {
            return Err(HostError::invalid_response());
        }
        Ok(Self {
            turn_id,
            stream_release: None,
        })
    }

    /// Attaches a one-shot release to a response whose serialized value must
    /// reach the IPC caller before its background stream starts emitting.
    /// The release is intentionally skipped by serde and is consumed on drop
    /// after the command framework has serialized the typed response.
    pub(crate) fn with_stream_release(
        turn_id: String,
        release: mpsc::Sender<()>,
    ) -> Result<Self, HostError> {
        if turn_id.is_empty() {
            return Err(HostError::invalid_response());
        }
        Ok(Self {
            turn_id,
            stream_release: Some(release),
        })
    }
}

impl Drop for StartTurnResponse {
    fn drop(&mut self) {
        if let Some(release) = self.stream_release.take() {
            let _ = release.send(());
        }
    }
}

/// Success payload of `agent_cancel_turn`: exactly one `ok` field, always
/// true on the success path.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CancelTurnResponse {
    ok: bool,
}

#[allow(dead_code)]
impl CancelTurnResponse {
    pub fn ok() -> Self {
        Self { ok: true }
    }
}

/// Closed response shapes for the configuration IPC commands. The nested
/// values are accepted only after the Node proxy applies the provider/route
/// allow-list validation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigSnapshotResponse {
    pub version: u32,
    pub providers: Vec<serde_json::Value>,
    pub routes: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProviderConfigResponse {
    pub provider: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteConfigResponse {
    pub route: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigDeleteResponse {
    pub ok: bool,
}

/// A pluggable Agent backend behind the fixed IPC commands.
///
/// Implementations are wired in through [`crate::runtime::HostRuntime`] and
/// must remain offline in the MVP: no upstream model access, no hidden
/// values, no network and no child processes.
pub trait HostBackend: Send + Sync {
    fn create_session(&self) -> Result<CreateSessionResponse, HostError>;

    fn start_turn(
        &self,
        session_id: &str,
        request: &serde_json::Value,
    ) -> Result<StartTurnResponse, HostError>;

    fn cancel_turn(&self, session_id: &str, turn_id: &str)
        -> Result<CancelTurnResponse, HostError>;
}

/// Configuration operations are a separate seam so the existing model
/// backend contract remains focused on turns. Production uses the same
/// loopback sidecar object for both seams; tests can inject either one.
pub trait ConfigBackend: Send + Sync {
    fn get_config(&self) -> Result<ConfigSnapshotResponse, HostError>;
    fn create_provider(
        &self,
        provider: &serde_json::Value,
    ) -> Result<ProviderConfigResponse, HostError>;
    fn update_provider(
        &self,
        provider: &serde_json::Value,
    ) -> Result<ProviderConfigResponse, HostError>;
    fn delete_provider(&self, provider_id: &str) -> Result<ConfigDeleteResponse, HostError>;
    fn create_route(&self, route: &serde_json::Value) -> Result<RouteConfigResponse, HostError>;
    fn update_route(&self, route: &serde_json::Value) -> Result<RouteConfigResponse, HostError>;
    fn delete_route(&self, route_id: &str) -> Result<ConfigDeleteResponse, HostError>;
}

/// Production-safe default before a Node sidecar is wired.
pub struct NotReadyConfigBackend;

impl ConfigBackend for NotReadyConfigBackend {
    fn get_config(&self) -> Result<ConfigSnapshotResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }

    fn create_provider(
        &self,
        _provider: &serde_json::Value,
    ) -> Result<ProviderConfigResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }

    fn update_provider(
        &self,
        _provider: &serde_json::Value,
    ) -> Result<ProviderConfigResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }

    fn delete_provider(&self, _provider_id: &str) -> Result<ConfigDeleteResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }

    fn create_route(&self, _route: &serde_json::Value) -> Result<RouteConfigResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }

    fn update_route(&self, _route: &serde_json::Value) -> Result<RouteConfigResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }

    fn delete_route(&self, _route_id: &str) -> Result<ConfigDeleteResponse, HostError> {
        Err(HostError::configuration_unavailable())
    }
}

/// Production default backend.
///
/// The Agent backend has not been assembled yet, so every operation answers
/// with the fixed `host_not_ready` error. Nothing is fabricated: no session,
/// no turn id, no streaming event.
pub struct NotReadyBackend;

impl HostBackend for NotReadyBackend {
    fn create_session(&self) -> Result<CreateSessionResponse, HostError> {
        Err(HostError::host_not_ready())
    }

    fn start_turn(
        &self,
        _session_id: &str,
        _request: &serde_json::Value,
    ) -> Result<StartTurnResponse, HostError> {
        Err(HostError::host_not_ready())
    }

    fn cancel_turn(
        &self,
        _session_id: &str,
        _turn_id: &str,
    ) -> Result<CancelTurnResponse, HostError> {
        Err(HostError::host_not_ready())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn create_session_response_serializes_exactly() {
        let session = HostSession::new(
            String::from("session-1"),
            HostSessionStatus::Idle,
            1000.0,
            1000.0,
            None,
        )
        .expect("valid");
        let value = serde_json::to_value(CreateSessionResponse::new(session)).expect("serialize");
        assert_eq!(
            value,
            json!({
                "session": {
                    "id": "session-1",
                    "status": "idle",
                    "createdAt": 1000.0,
                    "updatedAt": 1000.0
                }
            })
        );
    }

    #[test]
    fn host_session_serializes_exactly_and_omits_unset_active_turn() {
        let session = HostSession::new(
            String::from("session-1"),
            HostSessionStatus::Running,
            1000.5,
            2000.5,
            Some(String::from("turn-1")),
        )
        .expect("valid");
        let value = serde_json::to_value(&session).expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 5);
        assert_eq!(object["id"], "session-1");
        assert_eq!(object["status"], "running");
        assert_eq!(object["createdAt"], 1000.5);
        assert_eq!(object["updatedAt"], 2000.5);
        assert_eq!(object["activeTurnId"], "turn-1");

        let idle = HostSession::new(
            String::from("session-2"),
            HostSessionStatus::Idle,
            1.0,
            1.0,
            None,
        )
        .expect("valid");
        let value = serde_json::to_value(&idle).expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 4);
        assert!(!object.contains_key("activeTurnId"));
    }

    #[test]
    fn host_session_rejects_empty_id_and_non_finite_times() {
        assert_eq!(
            HostSession::new(String::new(), HostSessionStatus::Idle, 1.0, 1.0, None),
            Err(HostError::invalid_response())
        );
        assert_eq!(
            HostSession::new(
                String::from("session-1"),
                HostSessionStatus::Idle,
                f64::NAN,
                1.0,
                None
            ),
            Err(HostError::invalid_response())
        );
        assert_eq!(
            HostSession::new(
                String::from("session-1"),
                HostSessionStatus::Idle,
                1.0,
                f64::INFINITY,
                None
            ),
            Err(HostError::invalid_response())
        );
    }

    #[test]
    fn host_session_rejects_empty_active_turn_id() {
        assert_eq!(
            HostSession::new(
                String::from("session-1"),
                HostSessionStatus::Idle,
                1.0,
                1.0,
                Some(String::new())
            ),
            Err(HostError::invalid_response())
        );
    }

    #[test]
    fn start_turn_response_serializes_exactly() {
        let response = StartTurnResponse::new(String::from("turn-1")).expect("valid");
        let value = serde_json::to_value(&response).expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 1);
        assert_eq!(object["turnId"], "turn-1");
    }

    #[test]
    fn start_turn_response_rejects_empty_turn_id() {
        assert_eq!(
            StartTurnResponse::new(String::new()),
            Err(HostError::invalid_response())
        );
    }

    #[test]
    fn cancel_turn_response_serializes_exactly() {
        let value = serde_json::to_value(CancelTurnResponse::ok()).expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 1);
        assert_eq!(object["ok"], true);
    }

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
