# Windows desktop credentials

The desktop stores API keys as Windows Generic Credentials, scoped to the current
Windows user, persisted with `CRED_PERSIST_LOCAL_MACHINE`. This persistence flag
survives logoff; it does not make credentials readable by all machine users.
Targets are exactly `AgentWorkbench/credentials/v1/<credentialRef>`. No enumeration
or access to unrelated targets is implemented. No plaintext key file or shared
encryption key is used.

## Integration contract

Renderer: `createDesktopCredentialClient({ invoke })` from
`apps/desktop/src/credential-client.ts`, returning `DesktopCredentialClient`:

- `set(credentialRef, secret): Promise<void>` calls `agent_set_credential`.
- `has(credentialRef): Promise<boolean>` calls `agent_has_credential`.
- `delete(credentialRef): Promise<void>` calls `agent_delete_credential`.

Tauri arguments are `{ credentialRef, secret }` for set and `{ credentialRef }`
otherwise. Set/delete return JSON null, has returns a boolean. All operation
failures are fixed `Credential operation failed.` errors. There is no renderer
get command. Clear the password field after saving, and never put the key in
provider config, localStorage, diagnostics, event payloads or application state.
Keep only the credential reference in provider config. Deleting a provider does
not delete a potentially shared credential automatically.

The native host registers `commands::agent_set_credential`,
`commands::agent_has_credential`, and `commands::agent_delete_credential` in
`lib.rs`'s invoke handler. The credentials implementation is a private native
module shared by the command layer and the helper entry point. Pass the absolute result of
`std::env::current_exe()` to the Node sidecar as `--credential-helper <path>`
alongside `--config`. This flag is a trusted native launch setting, never a
provider configuration field or renderer input.

`main.rs` intercepts `--credential-read <credentialRef>` before initializing
Tauri. Malformed reserved-flag requests exit without UI. The helper reads only
the scoped target and writes the plaintext key, without a newline, to its private
stdout pipe. Exit 0 means success, 3 means absent, 2 means invalid/failure; errors
produce no output. No secret appears in command arguments. Node spawns the host
directly without a shell, hides its window, ignores stderr, bounds stdout to 2560
bytes, and kills it after five seconds. Missing/malformed/failed reads resolve
to undefined, preserving the gateway's existing missing-credential behavior.
Node writes and deletes are rejected; native IPC owns modifications.

References match `^credential:[a-z][a-z0-9._-]{0,63}$`. Keys must contain 1–2560
printable ASCII bytes without spaces, matching API header token use; newline,
NUL, whitespace and oversized input are rejected before storage. This is an API
key store, not a general password store. Unsupported platforms fail closed.

## Security boundary and verification

Windows user isolation protects persistence. Other processes running as the same
user may read Generic Credentials; the helper is not a defense against a compromised
Windows account. Plaintext necessarily exists briefly in the input field, native
process, pipe and backend request memory. Mutable temporary buffers are cleared
where practical; JavaScript strings cannot be reliably zeroized. Do not enable
IPC payload logging or capture helper stdout in application logs.

`tests/desktop-credentials.test.ts` covers renderer validation, safe errors,
read-only source behavior, missing helpers and backend class compatibility.
`apps/desktop/src-tauri/tests/credentials.rs` uses a unique synthetic credential,
checks set/read/overwrite/has/delete plus the real headless child executable, and
cleans the synthetic entry with a drop guard. It never reads existing keys.
