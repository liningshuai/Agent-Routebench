//! Node Local Agent Host sidecar supervisor.
//!
//! Owns the lifecycle of a Node child process that serves the loopback
//! Local Agent API. Never uses a shell, never binds non-loopback, never
//! leaks paths or raw errors across the IPC boundary.

use std::io::Read;
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::errors::HostError;

/// Fixed loopback host the Node sidecar may bind to.
pub const SIDECAR_LOOPBACK_HOST: &str = "127.0.0.1";
/// Default loopback port used by the Desktop sidecar.
pub const SIDECAR_DEFAULT_PORT: u16 = 4317;
/// Bounded wait for a health probe during start.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Bounded wait for child exit during stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// Poll interval for health probes and child-exit checks.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Observable lifecycle state of the Node sidecar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    Created,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

/// Strictly validated launch description for the Node sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarLaunchConfig {
    pub executable: String,
    pub script_path: String,
    pub host: String,
    pub port: u16,
}

impl SidecarLaunchConfig {
    /// Builds a validated launch config. Rejects empty paths, non-loopback
    /// hosts, out-of-range ports and unknown field shapes. Messages are fixed
    /// and never echo the rejected value.
    pub fn new(
        executable: impl Into<String>,
        script_path: impl Into<String>,
        host: impl Into<String>,
        port: u16,
    ) -> Result<Self, HostError> {
        let executable = executable.into();
        let script_path = script_path.into();
        let host = host.into();

        if executable.trim().is_empty() {
            return Err(HostError::invalid_sidecar_options());
        }
        if script_path.trim().is_empty() {
            return Err(HostError::invalid_sidecar_options());
        }
        if executable.contains('\0') || script_path.contains('\0') {
            return Err(HostError::invalid_sidecar_options());
        }
        if host != SIDECAR_LOOPBACK_HOST {
            return Err(HostError::invalid_sidecar_options());
        }
        if port == 0 {
            return Err(HostError::invalid_sidecar_options());
        }

        Ok(Self {
            executable,
            script_path,
            host,
            port,
        })
    }
}

/// Injectable process seam so tests never spawn a real Node child.
pub trait ProcessLauncher: Send + Sync {
    fn spawn(&self, config: &SidecarLaunchConfig) -> Result<Box<dyn ChildProcess>, HostError>;
}

/// Injectable child-process seam.
pub trait ChildProcess: Send {
    fn try_wait(&mut self) -> Result<Option<i32>, HostError>;
    fn kill(&mut self) -> Result<(), HostError>;
    fn wait_with_timeout(&mut self, timeout: Duration) -> Result<Option<i32>, HostError>;
}

/// Injectable health probe seam.
pub trait HealthProbe: Send + Sync {
    fn check(&self, host: &str, port: u16) -> bool;
}

/// Production launcher: `std::process::Command`, no shell.
pub struct StdProcessLauncher;

impl ProcessLauncher for StdProcessLauncher {
    fn spawn(&self, config: &SidecarLaunchConfig) -> Result<Box<dyn ChildProcess>, HostError> {
        // Never use cmd /c, powershell, bash or sh.
        let mut command = Command::new(&config.executable);
        command
            .arg(&config.script_path)
            .arg("--host")
            .arg(&config.host)
            .arg("--port")
            .arg(config.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = command
            .spawn()
            .map_err(|_| HostError::sidecar_start_failed())?;
        Ok(Box::new(StdChildProcess { child }))
    }
}

struct StdChildProcess {
    child: Child,
}

impl ChildProcess for StdChildProcess {
    fn try_wait(&mut self) -> Result<Option<i32>, HostError> {
        match self.child.try_wait() {
            Ok(Some(status)) => Ok(status.code()),
            Ok(None) => Ok(None),
            Err(_) => Err(HostError::sidecar_stop_failed()),
        }
    }

    fn kill(&mut self) -> Result<(), HostError> {
        // Drain pipes in the background so a full buffer cannot deadlock kill.
        if let Some(mut stdout) = self.child.stdout.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = stdout.read_to_end(&mut sink);
            });
        }
        if let Some(mut stderr) = self.child.stderr.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = stderr.read_to_end(&mut sink);
            });
        }
        self.child
            .kill()
            .map_err(|_| HostError::sidecar_stop_failed())
    }

    fn wait_with_timeout(&mut self, timeout: Duration) -> Result<Option<i32>, HostError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(code) = self.try_wait()? {
                return Ok(Some(code));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

/// Production health probe: TCP connect to the loopback port only.
pub struct TcpHealthProbe;

impl HealthProbe for TcpHealthProbe {
    fn check(&self, host: &str, port: u16) -> bool {
        if host != SIDECAR_LOOPBACK_HOST {
            return false;
        }
        TcpStream::connect_timeout(
            &format!("{host}:{port}").parse().expect("loopback parse"),
            Duration::from_millis(200),
        )
        .is_ok()
    }
}

/// Owns one Node sidecar child process.
pub struct NodeHostSupervisor {
    state: Mutex<SidecarState>,
    child: Mutex<Option<Box<dyn ChildProcess>>>,
    config: SidecarLaunchConfig,
    launcher: Box<dyn ProcessLauncher>,
    probe: Box<dyn HealthProbe>,
    health_timeout: Duration,
}

impl NodeHostSupervisor {
    pub fn new(config: SidecarLaunchConfig) -> Self {
        Self {
            state: Mutex::new(SidecarState::Created),
            child: Mutex::new(None),
            config,
            launcher: Box::new(StdProcessLauncher),
            probe: Box::new(TcpHealthProbe),
            health_timeout: HEALTH_TIMEOUT,
        }
    }

    /// Test-only constructor with injected seams and a short health timeout.
    pub fn with_seams(
        config: SidecarLaunchConfig,
        launcher: Box<dyn ProcessLauncher>,
        probe: Box<dyn HealthProbe>,
    ) -> Self {
        Self {
            state: Mutex::new(SidecarState::Created),
            child: Mutex::new(None),
            config,
            launcher,
            probe,
            health_timeout: Duration::from_millis(200),
        }
    }

    pub fn state(&self) -> SidecarState {
        *self.state.lock().expect("state lock")
    }

    pub fn config(&self) -> &SidecarLaunchConfig {
        &self.config
    }

    /// Idempotent start. Concurrent callers share one child.
    pub fn start(&self) -> Result<(), HostError> {
        {
            let mut state = self.state.lock().expect("state lock");
            match *state {
                SidecarState::Running => return Ok(()),
                SidecarState::Starting => return Err(HostError::sidecar_start_failed()),
                SidecarState::Stopping => return Err(HostError::sidecar_start_failed()),
                SidecarState::Created | SidecarState::Stopped | SidecarState::Failed => {
                    *state = SidecarState::Starting;
                }
            }
        }

        let child = match self.launcher.spawn(&self.config) {
            Ok(child) => child,
            Err(error) => {
                *self.state.lock().expect("state lock") = SidecarState::Failed;
                return Err(error);
            }
        };

        *self.child.lock().expect("child lock") = Some(child);

        // Bounded health poll before reporting running.
        let deadline = Instant::now() + self.health_timeout;
        loop {
            // If the child already exited, fail immediately.
            let exited = {
                let mut guard = self.child.lock().expect("child lock");
                match guard.as_mut() {
                    Some(process) => match process.try_wait() {
                        Ok(Some(_)) => true,
                        Ok(None) => false,
                        Err(error) => {
                            *self.state.lock().expect("state lock") = SidecarState::Failed;
                            *guard = None;
                            return Err(error);
                        }
                    },
                    None => true,
                }
            };
            if exited {
                *self.state.lock().expect("state lock") = SidecarState::Failed;
                *self.child.lock().expect("child lock") = None;
                return Err(HostError::sidecar_start_failed());
            }

            if self.probe.check(&self.config.host, self.config.port) {
                *self.state.lock().expect("state lock") = SidecarState::Running;
                return Ok(());
            }

            if Instant::now() >= deadline {
                // Health never came up: kill the child and fail.
                let _ = self.force_stop_child();
                *self.state.lock().expect("state lock") = SidecarState::Failed;
                return Err(HostError::sidecar_health_timeout());
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Idempotent stop. Safe when never started.
    pub fn stop(&self) -> Result<(), HostError> {
        {
            let mut state = self.state.lock().expect("state lock");
            match *state {
                SidecarState::Created | SidecarState::Stopped => {
                    *state = SidecarState::Stopped;
                    return Ok(());
                }
                SidecarState::Stopping => return Ok(()),
                SidecarState::Starting | SidecarState::Running | SidecarState::Failed => {
                    *state = SidecarState::Stopping;
                }
            }
        }

        match self.force_stop_child() {
            Ok(()) => {
                *self.state.lock().expect("state lock") = SidecarState::Stopped;
                Ok(())
            }
            Err(error) => {
                *self.state.lock().expect("state lock") = SidecarState::Failed;
                Err(error)
            }
        }
    }

    fn force_stop_child(&self) -> Result<(), HostError> {
        let mut guard = self.child.lock().expect("child lock");
        let Some(mut process) = guard.take() else {
            return Ok(());
        };
        let _ = process.kill();
        match process.wait_with_timeout(STOP_TIMEOUT) {
            Ok(_) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

impl Drop for NodeHostSupervisor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Checks that a path looks like a usable file without reading it.
#[allow(dead_code)]
pub fn path_is_non_empty(path: &str) -> bool {
    !path.trim().is_empty() && Path::new(path).as_os_str().len() > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    struct FakeChild {
        exited: AtomicBool,
        killed: AtomicBool,
        exit_code: i32,
    }

    impl FakeChild {
        fn running() -> Self {
            Self {
                exited: AtomicBool::new(false),
                killed: AtomicBool::new(false),
                exit_code: 0,
            }
        }

        fn already_exited() -> Self {
            Self {
                exited: AtomicBool::new(true),
                killed: AtomicBool::new(false),
                exit_code: 1,
            }
        }
    }

    impl ChildProcess for FakeChild {
        fn try_wait(&mut self) -> Result<Option<i32>, HostError> {
            if self.exited.load(Ordering::SeqCst) {
                Ok(Some(self.exit_code))
            } else {
                Ok(None)
            }
        }

        fn kill(&mut self) -> Result<(), HostError> {
            self.killed.store(true, Ordering::SeqCst);
            self.exited.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn wait_with_timeout(&mut self, _timeout: Duration) -> Result<Option<i32>, HostError> {
            self.exited.store(true, Ordering::SeqCst);
            Ok(Some(self.exit_code))
        }
    }

    struct FakeLauncher {
        spawn_count: AtomicUsize,
        fail: AtomicBool,
        child_already_exited: AtomicBool,
    }

    impl FakeLauncher {
        fn ok() -> Self {
            Self {
                spawn_count: AtomicUsize::new(0),
                fail: AtomicBool::new(false),
                child_already_exited: AtomicBool::new(false),
            }
        }
    }

    impl ProcessLauncher for FakeLauncher {
        fn spawn(&self, _config: &SidecarLaunchConfig) -> Result<Box<dyn ChildProcess>, HostError> {
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) {
                return Err(HostError::sidecar_start_failed());
            }
            if self.child_already_exited.load(Ordering::SeqCst) {
                Ok(Box::new(FakeChild::already_exited()))
            } else {
                Ok(Box::new(FakeChild::running()))
            }
        }
    }

    struct CountingProbe {
        healthy: AtomicBool,
        calls: AtomicUsize,
    }

    impl CountingProbe {
        fn healthy() -> Self {
            Self {
                healthy: AtomicBool::new(true),
                calls: AtomicUsize::new(0),
            }
        }

        fn unhealthy() -> Self {
            Self {
                healthy: AtomicBool::new(false),
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl HealthProbe for CountingProbe {
        fn check(&self, _host: &str, _port: u16) -> bool {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.healthy.load(Ordering::SeqCst)
        }
    }

    fn valid_config() -> SidecarLaunchConfig {
        SidecarLaunchConfig::new("node", "/app/main.js", "127.0.0.1", 4317).expect("valid")
    }

    // ── Launch config validation ──────────────────────────────────────────

    #[test]
    fn config_accepts_loopback_and_safe_port() {
        let config = SidecarLaunchConfig::new("node", "/app/main.js", "127.0.0.1", 4317);
        assert!(config.is_ok());
    }

    #[test]
    fn config_rejects_empty_executable() {
        let config = SidecarLaunchConfig::new("", "/app/main.js", "127.0.0.1", 4317);
        assert_eq!(config, Err(HostError::invalid_sidecar_options()));
    }

    #[test]
    fn config_rejects_empty_script_path() {
        let config = SidecarLaunchConfig::new("node", "", "127.0.0.1", 4317);
        assert_eq!(config, Err(HostError::invalid_sidecar_options()));
    }

    #[test]
    fn config_rejects_non_loopback_host() {
        let config = SidecarLaunchConfig::new("node", "/app/main.js", "0.0.0.0", 4317);
        assert_eq!(config, Err(HostError::invalid_sidecar_options()));
    }

    #[test]
    fn config_rejects_ipv6_host() {
        let config = SidecarLaunchConfig::new("node", "/app/main.js", "::1", 4317);
        assert_eq!(config, Err(HostError::invalid_sidecar_options()));
    }

    #[test]
    fn config_rejects_port_zero() {
        let config = SidecarLaunchConfig::new("node", "/app/main.js", "127.0.0.1", 0);
        assert_eq!(config, Err(HostError::invalid_sidecar_options()));
    }

    #[test]
    fn config_rejects_null_byte_in_executable() {
        let config = SidecarLaunchConfig::new("no\0de", "/app/main.js", "127.0.0.1", 4317);
        assert_eq!(config, Err(HostError::invalid_sidecar_options()));
    }

    #[test]
    fn config_error_messages_are_fixed() {
        let error = SidecarLaunchConfig::new("", "", "0.0.0.0", 0).expect_err("must fail");
        assert_eq!(error.code, "invalid_sidecar_options");
        assert_eq!(error.message, "Sidecar options are invalid.");
        assert!(!error.message.contains("0.0.0.0"));
    }

    // ── State machine ─────────────────────────────────────────────────────

    #[test]
    fn new_supervisor_starts_in_created_state() {
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        assert_eq!(supervisor.state(), SidecarState::Created);
    }

    #[test]
    fn start_transitions_to_running_on_healthy_probe() {
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        supervisor.start().expect("start");
        assert_eq!(supervisor.state(), SidecarState::Running);
    }

    #[test]
    fn start_is_idempotent_when_already_running() {
        let launcher = Arc::new(FakeLauncher::ok());
        let probe = Arc::new(CountingProbe::healthy());
        // Use raw boxes; count via a shared launcher would need Arc. Use a second start call.
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        supervisor.start().expect("first start");
        supervisor.start().expect("second start is a no-op");
        assert_eq!(supervisor.state(), SidecarState::Running);
        let _ = launcher;
        let _ = probe;
    }

    #[test]
    fn start_fails_when_launcher_fails() {
        let launcher = FakeLauncher {
            spawn_count: AtomicUsize::new(0),
            fail: AtomicBool::new(true),
            child_already_exited: AtomicBool::new(false),
        };
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(launcher),
            Box::new(CountingProbe::healthy()),
        );
        assert_eq!(supervisor.start(), Err(HostError::sidecar_start_failed()));
        assert_eq!(supervisor.state(), SidecarState::Failed);
    }

    #[test]
    fn start_fails_when_child_exits_immediately() {
        let launcher = FakeLauncher {
            spawn_count: AtomicUsize::new(0),
            fail: AtomicBool::new(false),
            child_already_exited: AtomicBool::new(true),
        };
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(launcher),
            Box::new(CountingProbe::healthy()),
        );
        assert_eq!(supervisor.start(), Err(HostError::sidecar_start_failed()));
        assert_eq!(supervisor.state(), SidecarState::Failed);
    }

    #[test]
    fn start_fails_when_health_never_comes_up() {
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::unhealthy()),
        );
        // This test would block for HEALTH_TIMEOUT in production; the fake
        // probe returns false immediately so the deadline check fires after
        // the first poll. We accept the timeout error code.
        let result = supervisor.start();
        assert!(result.is_err());
        let error = result.expect_err("must fail");
        assert_eq!(error.code, "sidecar_health_timeout");
    }

    #[test]
    fn stop_is_safe_when_never_started() {
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        supervisor.stop().expect("stop on created");
        assert_eq!(supervisor.state(), SidecarState::Stopped);
    }

    #[test]
    fn stop_transitions_to_stopped_from_running() {
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        supervisor.start().expect("start");
        supervisor.stop().expect("stop");
        assert_eq!(supervisor.state(), SidecarState::Stopped);
    }

    #[test]
    fn stop_is_idempotent() {
        let supervisor = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        supervisor.start().expect("start");
        supervisor.stop().expect("first stop");
        supervisor.stop().expect("second stop");
        assert_eq!(supervisor.state(), SidecarState::Stopped);
    }

    #[test]
    fn two_supervisors_are_isolated() {
        let a = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        let b = NodeHostSupervisor::with_seams(
            valid_config(),
            Box::new(FakeLauncher::ok()),
            Box::new(CountingProbe::healthy()),
        );
        a.start().expect("a start");
        assert_eq!(a.state(), SidecarState::Running);
        assert_eq!(b.state(), SidecarState::Created);
        a.stop().expect("a stop");
        assert_eq!(b.state(), SidecarState::Created);
    }

    #[test]
    fn error_codes_are_fixed() {
        assert_eq!(
            HostError::sidecar_start_failed().code,
            "sidecar_start_failed"
        );
        assert_eq!(
            HostError::sidecar_health_timeout().code,
            "sidecar_health_timeout"
        );
        assert_eq!(HostError::sidecar_not_ready().code, "sidecar_not_ready");
        assert_eq!(HostError::sidecar_stop_failed().code, "sidecar_stop_failed");
        assert_eq!(
            HostError::invalid_sidecar_options().code,
            "invalid_sidecar_options"
        );
    }

    #[test]
    fn error_messages_never_embed_dynamic_content() {
        let error = HostError::sidecar_start_failed();
        assert_eq!(error.message, "Sidecar failed to start.");
        assert!(!error.message.contains("node"));
        assert!(!error.message.contains("/app"));
    }

    #[test]
    fn probe_only_checks_loopback() {
        let probe = TcpHealthProbe;
        assert!(!probe.check("0.0.0.0", 4317));
        assert!(!probe.check("example.com", 4317));
    }
}
