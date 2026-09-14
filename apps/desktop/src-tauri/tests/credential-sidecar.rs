use agent_routebench_lib::sidecar::SidecarLaunchConfig;

#[test]
fn rejects_relative_and_non_executable_helper_paths() {
    for path in [
        "",
        "host.exe",
        "../host.exe",
        "C:\\host.cmd",
        "C:\\bad\0.exe",
    ] {
        let config = SidecarLaunchConfig::new("node", "main.js", "127.0.0.1", 4317).unwrap();
        assert!(
            config.with_credential_helper(path).is_err(),
            "invalid helper accepted"
        );
    }
}
