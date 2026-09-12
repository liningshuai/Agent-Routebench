//! Per-application runtime container for the native host.
//!
//! Each Tauri App instance owns exactly one [`HostRuntime`], registered via
//! `tauri::Builder::manage`. There is no global state: two runtimes never
//! share a backend, and the backend can only be replaced through the explicit
//! [`HostRuntime::with_backend`] constructor, which is reserved for tests and
//! future backend assembly.

use std::sync::Arc;

use crate::backend::{HostBackend, NotReadyBackend};

/// Owns the currently wired [`HostBackend`].
pub struct HostRuntime {
    backend: Arc<dyn HostBackend>,
}

impl HostRuntime {
    /// Production default: a fresh runtime wrapping [`NotReadyBackend`].
    pub fn not_ready() -> Self {
        Self {
            backend: Arc::new(NotReadyBackend),
        }
    }

    /// Explicit injection point for tests and future backend assembly.
    /// Unused in the MVP production build by design.
    #[allow(dead_code)]
    pub fn with_backend(backend: Arc<dyn HostBackend>) -> Self {
        Self { backend }
    }

    /// The wired backend, used by the fixed IPC commands after validation.
    pub fn backend(&self) -> &dyn HostBackend {
        self.backend.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::HostError;
    use serde_json::Value;
    use std::sync::Mutex;

    /// Test-only fake backend that records the calls it receives.
    ///
    /// It exists exclusively inside this `#[cfg(test)]` module and is never a
    /// production default.
    struct TestBackend {
        calls: Mutex<Vec<String>>,
        error: HostError,
    }

    impl TestBackend {
        fn failing() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                error: HostError::invalid_request(),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("lock").clone()
        }

        fn record(&self, call: &str) {
            self.calls.lock().expect("lock").push(String::from(call));
        }
    }

    impl HostBackend for TestBackend {
        fn create_session(&self) -> Result<Value, HostError> {
            self.record("create_session");
            Err(self.error.clone())
        }

        fn start_turn(&self, _session_id: &str, _request: &Value) -> Result<Value, HostError> {
            self.record("start_turn");
            Err(self.error.clone())
        }

        fn cancel_turn(&self, _session_id: &str, _turn_id: &str) -> Result<Value, HostError> {
            self.record("cancel_turn");
            Err(self.error.clone())
        }
    }

    #[test]
    fn not_ready_factory_wires_the_not_ready_backend() {
        let runtime = HostRuntime::not_ready();
        assert_eq!(
            runtime.backend().create_session(),
            Err(HostError::host_not_ready())
        );
    }

    #[test]
    fn with_backend_injects_the_fake_and_records_the_call() {
        let fake = Arc::new(TestBackend::failing());
        let runtime = HostRuntime::with_backend(fake.clone());
        assert_eq!(
            runtime.backend().create_session(),
            Err(HostError::invalid_request())
        );
        assert_eq!(fake.calls(), vec!["create_session".to_string()]);
    }

    #[test]
    fn runtime_instances_are_isolated_from_each_other() {
        let first = Arc::new(TestBackend::failing());
        let second = Arc::new(TestBackend::failing());
        let runtime_a = HostRuntime::with_backend(first.clone());
        let runtime_b = HostRuntime::with_backend(second.clone());

        let _ = runtime_a.backend().create_session();
        assert!(first.calls().len() == 1);
        assert!(second.calls().is_empty());

        let _ = runtime_b.backend().cancel_turn("session-1", "turn-1");
        assert!(first.calls().len() == 1);
        assert_eq!(second.calls(), vec!["cancel_turn".to_string()]);
    }

    #[test]
    fn repeated_calls_accumulate_no_shared_global_state() {
        let fake = Arc::new(TestBackend::failing());
        let runtime = HostRuntime::with_backend(fake.clone());
        for _ in 0..3 {
            let _ = runtime.backend().create_session();
        }
        assert_eq!(fake.calls().len(), 3);

        // A newly created not-ready runtime shares nothing with the one above.
        let fresh = HostRuntime::not_ready();
        assert_eq!(
            fresh.backend().create_session(),
            Err(HostError::host_not_ready())
        );
        assert_eq!(fake.calls().len(), 3);
    }

    #[test]
    fn backend_arguments_are_passed_through_unchanged() {
        struct EchoBackend;

        impl HostBackend for EchoBackend {
            fn create_session(&self) -> Result<Value, HostError> {
                Err(HostError::host_not_ready())
            }

            fn start_turn(&self, session_id: &str, request: &Value) -> Result<Value, HostError> {
                Ok(serde_json::json!({
                    "seenSessionId": session_id,
                    "seenRequestKeys": request.as_object().map(|o| o.len()).unwrap_or(0)
                }))
            }

            fn cancel_turn(&self, _session_id: &str, _turn_id: &str) -> Result<Value, HostError> {
                Err(HostError::host_not_ready())
            }
        }

        let runtime = HostRuntime::with_backend(Arc::new(EchoBackend));
        let request = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        let result = runtime
            .backend()
            .start_turn("session-abc", &request)
            .expect("echo");
        assert_eq!(result["seenSessionId"], "session-abc");
        assert_eq!(result["seenRequestKeys"], 1);
    }

    #[test]
    fn backend_errors_reach_the_boundary_only_as_fixed_host_errors() {
        let runtime = HostRuntime::not_ready();
        let error = runtime.backend().cancel_turn("s", "t").expect_err("fixed");
        assert_eq!(error.code, "host_not_ready");
        assert_eq!(error.message, "Agent host backend is not ready.");
    }
}
