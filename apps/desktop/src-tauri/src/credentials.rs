//! App-scoped Windows Credential Manager access. Never enumerate credentials.
const ERROR: &str = "Credential operation failed.";
const MAX_BYTES: usize = 2560;

fn target(reference: &str) -> Result<Vec<u16>, &'static str> {
    let id = reference.strip_prefix("credential:").ok_or(ERROR)?;
    if id.is_empty()
        || id.len() > 64
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    {
        return Err(ERROR);
    }
    Ok(format!("AgentWorkbench/credentials/v1/{reference}\0")
        .encode_utf16()
        .collect())
}

fn valid_secret(secret: &str) -> bool {
    !secret.is_empty()
        && secret.len() <= MAX_BYTES
        && secret.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub fn set(reference: &str, secret: &str) -> Result<(), &'static str> {
    let target = target(reference)?;
    if !valid_secret(secret) {
        return Err(ERROR);
    }
    native::set(&target, secret)
}
pub fn read(reference: &str) -> Result<Option<String>, &'static str> {
    native::read(&target(reference)?)
}
pub fn has(reference: &str) -> Result<bool, &'static str> {
    Ok(read(reference)?.is_some())
}
pub fn delete(reference: &str) -> Result<(), &'static str> {
    native::delete(&target(reference)?)
}

/// Called before Tauri initialization. Any occurrence of the reserved flag is
/// handled here, including malformed requests; no helper request can open UI.
pub fn helper_exit_code(args: &[String]) -> Option<i32> {
    if !args.iter().any(|arg| arg == "--credential-read") {
        return None;
    }
    if args.len() != 2 || args[0] != "--credential-read" {
        return Some(2);
    }
    let result = read(&args[1]);
    Some(match result {
        Ok(Some(secret)) => {
            use std::io::Write;
            let mut bytes = secret.into_bytes();
            let result = std::io::stdout().lock().write_all(&bytes);
            bytes.fill(0);
            if result.is_ok() {
                0
            } else {
                2
            }
        }
        Ok(None) => 3,
        Err(_) => 2,
    })
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::*;

    pub fn set(target: &[u16], secret: &str) -> Result<(), &'static str> {
        let mut bytes = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_ptr() as *mut u16,
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..unsafe { std::mem::zeroed() }
        };
        let success = unsafe { CredWriteW(&credential, 0) };
        bytes.fill(0);
        if success == 0 {
            Err(ERROR)
        } else {
            Ok(())
        }
    }
    pub fn read(target: &[u16]) -> Result<Option<String>, &'static str> {
        let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) } == 0 {
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(ERROR)
            };
        }
        if ptr.is_null() {
            return Err(ERROR);
        }
        // The OS allocation is always released, including malformed entries.
        let result = unsafe {
            let credential = &*ptr;
            let len = credential.CredentialBlobSize as usize;
            if len == 0 || len > MAX_BYTES || credential.CredentialBlob.is_null() {
                Err(ERROR)
            } else {
                let blob = std::slice::from_raw_parts_mut(credential.CredentialBlob, len);
                let result = std::str::from_utf8(blob)
                    .ok()
                    .filter(|s| valid_secret(s))
                    .map(|s| Some(s.to_owned()))
                    .ok_or(ERROR);
                blob.fill(0);
                result
            }
        };
        unsafe {
            CredFree(ptr.cast());
        }
        result
    }
    pub fn delete(target: &[u16]) -> Result<(), &'static str> {
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || unsafe { GetLastError() } == ERROR_NOT_FOUND
        {
            Ok(())
        } else {
            Err(ERROR)
        }
    }
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn set(_: &[u16], _: &str) -> Result<(), &'static str> {
        Err(ERROR)
    }
    pub fn read(_: &[u16]) -> Result<Option<String>, &'static str> {
        Err(ERROR)
    }
    pub fn delete(_: &[u16]) -> Result<(), &'static str> {
        Err(ERROR)
    }
}
