#[path = "../src/credentials.rs"]
mod credentials;

#[test]
fn rejects_unscoped_references_and_invalid_secrets() {
    for reference in ["", "credential:../x", "credential:UPPER", "other:account"] {
        assert!(credentials::has(reference).is_err());
    }
    for secret in ["", "a\nb", "a b"] {
        assert!(credentials::set("credential:synthetic-validation", secret).is_err());
    }
    assert!(credentials::set("credential:synthetic-validation", &"a".repeat(2561)).is_err());
}

#[test]
#[cfg(windows)]
fn native_disposable_roundtrip() {
    let reference = format!(
        "credential:test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = credentials::delete(&self.0);
        }
    }
    assert!(!credentials::has(&reference).unwrap());
    let _cleanup = Cleanup(reference.clone());
    credentials::set(&reference, "synthetic-disposable-value").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_agent-routebench"))
        .args(["--credential-read", &reference])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stdout == b"synthetic-disposable-value");
    assert!(output.stderr.is_empty());
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../local-agent-host/dist/credential-source.js")
        .canonicalize()
        .unwrap();
    let node = std::process::Command::new("node")
        .args(["--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const {WindowsCredentialSource}=await import(pathToFileURL(process.argv[1])); const value=await new WindowsCredentialSource(process.argv[2]).get(process.argv[3]); if(value===undefined)process.exit(1); process.stdout.write(value);"])
        .arg(source).arg(env!("CARGO_BIN_EXE_agent-routebench")).arg(&reference)
        .output().unwrap();
    assert!(node.status.success());
    assert!(node.stdout == b"synthetic-disposable-value");
    assert!(node.stderr.is_empty());
    assert!(credentials::has(&reference).unwrap());
    assert!(
        credentials::read(&reference).unwrap().as_deref() == Some("synthetic-disposable-value")
    );
    credentials::set(&reference, "synthetic-replacement").unwrap();
    assert!(credentials::read(&reference).unwrap().as_deref() == Some("synthetic-replacement"));
    credentials::delete(&reference).unwrap();
    assert!(!credentials::has(&reference).unwrap());
    credentials::delete(&reference).unwrap();
}

#[test]
fn malformed_helper_request_exits_without_ui_or_output() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_agent-routebench"))
        .args(["--credential-read", "outside:target", "extra"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
