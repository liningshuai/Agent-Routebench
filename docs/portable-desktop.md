# Windows portable desktop

From the repository root on Windows, with the existing development prerequisites
(Corepack/pnpm, Node >=24, Rust/MSVC and the Windows SDK) installed:

```text
corepack pnpm exec node scripts/package-desktop.mjs
corepack pnpm exec node --test scripts/package-desktop.test.mjs
```

The packager builds the self-contained host, renderer and Tauri release executable
using the existing build scripts. Cargo metadata supplies the actual target directory.
It produces a new `dist/Agent-Routebench-portable-<timestamp>` directory. Use
`--output=C:/path/to/new-folder` to choose another destination. Existing destinations
are rejected without overwriting them. `--skip-build` packages existing release
outputs only; use it only after a successful current build. Interrupted packages
may remain incomplete; select a new output directory when retrying.

## Running

Copy the entire folder to the Windows machine and double-click
`agent-routebench.exe`. The recipient needs neither PowerShell nor system Node.
Keep the following files together:

```text
agent-routebench.exe
node.exe
local-agent-host/dist/     # includes package.json and vendored runtime dependencies
runtime-provenance.json
README.txt
NODE-LICENSE              # when available beside the source Node binary
LICENSE                   # when available in the repository root
```

The renderer is embedded in the release executable. No separate Tauri portable
configuration is needed: Windows Tauri resources resolve beside the executable.
The release selects the canonical absolute bundled Node path and fails if it is
missing. Only debug builds may fall back to `node` on PATH. Preserve this selection
block in `create_sidecar_supervisor` when adding credential module registration;
the `SidecarLaunchConfig::new` first argument is now `node_executable`.

Microsoft Edge WebView2 Runtime must already be installed. This is a portable app
folder, not a fully offline WebView2 installer, and configuration remains in the
Windows app configuration directory (`com.liningshuai.agentroutebench/config.json`),
not beside the executable. The current desktop host uses loopback port 4317; close
your own earlier instance normally before opening another. The package is unsigned.

## Runtime provenance

Node is resolved by executing `corepack pnpm exec node` in this repository, rather
than assuming the packaging process or shell uses the intended binary. The package
records a stable runtime label, version, platform, architecture and SHA-256, plus the
desktop executable SHA-256. It copies nearby `LICENSE` or `LICENSE.txt` as
`NODE-LICENSE` if present. Local license provenance is recorded as
`local-node-license`, never as a machine-specific path. If absent, provenance records `license: null`; obtain the
license for that exact Node release before redistributing externally. The packager
does not download or silently substitute a different runtime. Build natively for
the runtime architecture; cross-target packaging is not supported.

## Verification performed (2026-09-13)

- Fixture tests were written first and failed for the missing implementation, then
  passed: full nested host copy and checksums/license, existing-output protection,
  and rejection of missing host entry point. Fixtures use isolated OS temp folders.
- Native Tauri release build completed successfully, with existing dead-code warnings.
- Packaged Node v24.14.0 Windows x64 from `C:/Program Files/nodejs/node.exe`.
  SHA-256: `63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088`.
  That installation had no adjacent license file.
- Started the packaged host via its absolute bundled Node path with an empty PATH
  and an unrelated temporary working directory on an independently selected port.
  `/health` returned `{"ok":true,"service":"agent-workbench-local-api","version":1}`.
  Only the spawned test process was stopped afterward.
- Full desktop window launch remains unverified: an existing user Node process
  already owned port 4317 and was left running. The main integration task should
  rebuild/package after its remaining Rust/UI changes and verify the window when
  that port becomes available.

On this machine Node's recursive `cpSync` terminated with native exit code
`-1073740791` during a real directory copy. The packager therefore copies the host
tree explicitly with directory enumeration and file copies; the real package and
empty-PATH host smoke test passed with that implementation.
