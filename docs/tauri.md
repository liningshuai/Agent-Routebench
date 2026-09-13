# Tauri Desktop IPC Bridge

Task 17 adds the TypeScript-side IPC contract that lets a Tauri host provide
the existing DesktopApiClient without coupling the Desktop package to a
particular @tauri-apps/api version.

## MVP wiring

The host injects two functions:

~~~ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createTauriDesktopApiClient,
  mountDesktopUi,
} from "@agent-workbench/desktop";

const client = createTauriDesktopApiClient({ invoke, listen });
mountDesktopUi(document.getElementById("app")!, client);
~~~

The Tauri package is intentionally not a dependency of this workspace. The
injected functions are the only host boundary, which keeps the adapter
unit-testable and allows the native host to be added later.

## Fixed IPC contract

| Direction | Name | Payload |
| --- | --- | --- |
| invoke | agent_health | no arguments |
| invoke | agent_create_session | no arguments |
| invoke | agent_start_turn | { sessionId, request } |
| listen | agent_turn_event | { sessionId, turnId, event } |
| invoke | agent_cancel_turn | { sessionId, turnId } |

agent_start_turn returns exactly { turnId }. The event envelope is checked
before an event is handed to DesktopController; only events matching the
active session and turn are delivered. completed and error close the stream
after their event is delivered.

## Security and lifecycle boundaries

- Session responses, turn identifiers, turn requests and AgentEvents are
  validated at the IPC boundary.
- Unknown turn fields and credential-like fields are rejected before invoke.
- Provider URLs, credential values, authorization headers and tool input are
  not created or read by this adapter.
- Host errors are converted to fixed Desktop error messages.
- Error event messages are normalized to a fixed safe message.
- A pre-cancelled turn performs no host calls.
- AbortSignal cancellation ends a pending stream without waiting for a
  hanging host promise; a late rejection is consumed.
- Listener cleanup is attempted on terminal events, cancellation and early
  iterator exit. Cleanup failures do not escape to the renderer.
- The caller should invoke cancelTurn(sessionId, turnId) when it needs the
  native host to stop work; the signal also stops delivery to the renderer.
- No remote network, CredentialStore, Provider Registry or persistence layer
  is accessed here.

## Explicit non-goals

Task 17 does not add a Rust src-tauri project, Tauri permissions,
window/menu/tray APIs, native filesystem dialogs, or production host commands.
Those are host-application work that can consume this stable TypeScript
contract in a later task.

---

# Task 18 — Tauri Native Desktop Shell and Host IPC MVP

Task 18 adds the real Tauri 2 native host under `apps/desktop/src-tauri/`.
The project is now in an **alpha / early development** stage: the native
window starts, the fixed IPC contract is registered in Rust, and the
frontend entry is real — but the Agent backend is deliberately **not**
assembled yet (that is Task 21's job).

## What Task 18 delivers

- A compilable Tauri 2 Rust project: `src-tauri/Cargo.toml`, `build.rs`,
  `src/main.rs`, `src/lib.rs`, plus the focused modules `commands.rs`,
  `errors.rs` and `validation.rs`.
- The four fixed commands registered through
  `tauri::generate_handler!`: `agent_health`, `agent_create_session`,
  `agent_start_turn`, `agent_cancel_turn`. The names are byte-identical to
  `TAURI_COMMANDS` in `apps/desktop/src/tauri-api-client.ts`; the reserved
  event name `agent_turn_event` matches `TAURI_EVENTS`.
- A real Tauri frontend entry, `apps/desktop/src/tauri-entry.ts`, which
  imports the official `invoke` / `listen` from `@tauri-apps/api/core` and
  `@tauri-apps/api/event`, builds the client with the Task 17
  `createTauriDesktopApiClient` factory and mounts the existing
  `mountDesktopUi`. There is no second IPC implementation.
- A deterministic native-ESM build, `scripts/build-desktop.mjs`
  (`corepack pnpm build:desktop`): TypeScript compiles to
  `apps/desktop/dist`, the runtime import closure
  (`@tauri-apps/api`, `@agent-workbench/local-agent-client`,
  `@agent-workbench/agent-core`, `@agent-workbench/agent-contracts`) is
  vendored into `dist/vendor`, and bare specifiers are rewritten to relative
  paths. No bundler, no CDN, no external script. `dist/index.html` loads
  `./tauri-entry.js`; the browser preview (`public/index.html` +
  `docs/previews/desktop-ui-preview.html`) keeps using the browser entry and
  is untouched.
- A restricted, auditable configuration: `tauri.conf.json` sets
  `productName: "Agent Routebench"`,
  `identifier: com.liningshuai.agentroutebench`, `frontendDist: "../dist"`,
  no remote `devUrl`, a single `main` window (1440x960, min 1024x700,
  resizable) and a strict CSP (`default-src 'self'; script-src 'self';
  style-src 'self'`, plus the Tauri IPC loopback `connect-src ipc:
  http://ipc.localhost`). `bundle.active` is false — installers are a later
  task.
- Minimal capabilities (`capabilities/default.json`): only `core:event:default`
  for the `main` window. No shell, fs, http, process, sql, dialog,
  clipboard, notification, opener, global-shortcut, updater or tray plugin
  is referenced in the config or the Cargo manifest.

## Host behavior boundary (no fabricated backend)

`agent_health` reports only that the native host process is up:

~~~json
{ "ok": true, "service": "agent-workbench-tauri-host", "version": 1 }
~~~

Every backend-dependent command answers with the single fixed error
`{ "code": "host_not_ready", "message": "Agent host backend is not ready." }`:

- `agent_create_session` — never returns a fabricated session.
- `agent_start_turn` — validates the session id and the request first
  (unknown fields, sensitive fields such as `apiKey` / `token` /
  `authorization` / `headers` / `secret` / `password` / `credential` /
  `baseUrl` / `endpoint`, invalid `messages`, `tools` or `maxTokens` all
  fail with `invalid_request` / `forbidden_field` /
  `invalid_session_id`), then returns `host_not_ready`. No `text_delta`,
  `completed`, `tool_call` or `usage` event is ever fabricated.
- `agent_cancel_turn` — validates both identifiers, then returns
  `host_not_ready` instead of inventing a successful cancellation.

The fixed error vocabulary is `host_not_ready`, `invalid_request`,
`invalid_session_id`, `invalid_turn_id`, `forbidden_field`. Error messages
are static strings: no exception text, stack, path, URL or input echo ever
crosses the IPC boundary. The Task 17 bridge maps these to the fixed Desktop
error messages the renderer already handles.

## Security boundaries

- The Rust host reads no environment variables, spawns no processes, opens
  no network client and touches no filesystem or credential store.
- Cargo dependencies are limited to `tauri`, `tauri-build`, `serde` and
  `serde_json`. No provider SDK, no HTTP client crate, no plugin crates.
- The webview loads only same-origin assets under `frontendDist`
  (`../dist`); the built output never exposes `src`, tests, `node_modules`
  or `.superpowers/`.
- No real provider is contacted, no credential is read, no remote network is
  used — during tests or at runtime.

## What Task 18 does not do

- No full Agent backend assembly (Task 21 connects the complete backend).
- No CredentialStore, OS Keychain or secret persistence.
- No real model/provider calls, no shell/file/network tools, no approval UI.
- No system tray, native file dialogs, auto-update, or installer packaging
  (`tauri build --no-bundle` / `bundle.active: false` for this MVP).
- No Node side-process is started by the host.

---

# Task 19 — Native Host Runtime Boundary and Reproducible Build Hardening

Task 19 introduces an injectable backend seam inside the Rust host and pins
the Cargo build output to the repository root. The IPC contract, the
`host_not_ready` behavior and every security boundary from Task 18 are
unchanged. At the Task 19 checkpoint, Task 20 and Task 21 had not yet
started; Task 20 is now complete and Task 21 has assembled the Node backend
(the Tauri Rust host itself still runs standalone).

## HostBackend / HostRuntime

- `src-tauri/src/backend.rs` defines `pub trait HostBackend: Send + Sync` with
  exactly three methods (`create_session`, `start_turn`, `cancel_turn`). All
  three return command-specific typed responses —
  `Result<CreateSessionResponse, HostError>`,
  `Result<StartTurnResponse, HostError>` and
  `Result<CancelTurnResponse, HostError>` (see the typed success response
  section below). Because both the error type and the success types are
  fixed contracts, dynamic exception text, paths or URLs are
  unrepresentable at the boundary by construction. The raw
  `serde_json::Value` type appears only as the already-validated
  `agent_start_turn` request input; it is never an open success output.
- The production default is `NotReadyBackend`: it answers every operation
  with the fixed `host_not_ready` error and fabricates nothing.
- `src-tauri/src/runtime.rs` defines `HostRuntime { backend:
  Arc<dyn HostBackend> }`. `HostRuntime::not_ready()` builds a fresh
  instance per Tauri App; `with_backend(Arc<dyn HostBackend>)` is the only
  injection point and is used exclusively by tests. There is no global state,
  no `static mut`, no singleton.
- `lib.rs` registers the default runtime with
  `.manage(HostRuntime::not_ready())`. Each Tauri App instance owns exactly
  one runtime; two instances never share backend state.
- Commands keep the Task 18 order: receive arguments → validate
  (`sessionId` / `turnId` / request, sensitive fields first, unknown fields
  next) → on failure return the fixed error without consulting the backend →
  only then delegate to `runtime.backend()`. `agent_health` takes no state
  and never reads the backend.
- No fake backend exists in production code; test fakes live exclusively
  inside `#[cfg(test)]` modules.

## Cargo build output pinned to the repository root

- `.cargo/config.toml` sets `[build] target-dir = "target"`, resolved by
  cargo to the repository root for every invocation inside the repository
  (verified from the repo root and from `apps/desktop`).
- `apps/desktop/src-tauri/target/` never reappears; `corepack pnpm
  security:scan` runs cleanly while full build artifacts exist at the root
  (they are git-ignored and outside the scan roots). No scan-script
  modification was needed.
- Native builds do not depend on a shell-local `CARGO_TARGET_DIR`: the Task
  19 build tests delete that variable from the environment before running
  cargo and tauri.
- Caution: build-script metadata between crates carries absolute paths, so a
  target directory must never be MOVED. Change it via
  `.cargo/config.toml` plus `cargo clean` if ever needed.
- `scripts/build-desktop.mjs` additionally serializes concurrent builds with
  a cross-process lock, swaps a freshly built staging directory into `dist`
  atomically, and skips the build entirely when a content fingerprint over
  all inputs is unchanged.

## Task 19 收尾 — Typed native IPC success responses

The backend boundary no longer uses open `serde_json::Value` successes. The
raw `serde_json::Value` type is only allowed as the already-validated
`agent_start_turn` request *input*; every success crossing the IPC boundary
is a command-specific closed struct with private fields and a validated
constructor:

| Command | Success JSON |
| --- | --- |
| `agent_create_session` | `{ "session": { "id", "status", "createdAt", "updatedAt", "activeTurnId?" } }` — the wrapper has exactly one field; `status` is one of `idle`, `running`, `completed`, `cancelled`, `failed`; `activeTurnId` is omitted (never `null`) when unset |
| `agent_start_turn` | `{ "turnId": "…" }` — exactly one field; the request payload is never echoed back |
| `agent_cancel_turn` | `{ "ok": true }` — exactly one field, always `true` on the success path |

Constructors reject empty ids, empty turn ids, non-finite timestamps and
empty `activeTurnId` values with the fixed
`{ "code": "invalid_response", "message": "Agent host response is invalid." }`
error; the message never embeds serde text, JSON content, paths or input
echoes. `NotReadyBackend` is unchanged: it still fails all three operations
with the fixed `host_not_ready` error and fabricates nothing. Task 21 must
connect a real backend exclusively through this typed response contract;
no real backend, provider, credential store or model call exists yet.

---

# Task 23 — Native Node sidecar supervision

Task 23 adds the native lifecycle boundary for the Node Local Agent Host.
`NodeHostSupervisor` is created and started from the Tauri `setup` hook and is
stopped from the Tauri `RunEvent::Exit` callback. The existing typed Tauri IPC
bridge remains the renderer boundary; this task does not add a second renderer
protocol or expose sidecar internals to the UI.

## Sidecar guarantees

- `SidecarLaunchConfig` accepts only `node`, a non-empty script path,
  `127.0.0.1`, and a port from 1 through 65535.
- The child is launched with `std::process::Command` and direct arguments;
  no shell is involved.
- `TcpHealthProbe` performs a bounded HTTP `GET /health` and accepts only the
  exact `agent-workbench-local-api` health payload. A listening TCP port alone
  is not considered healthy.
- Child stdout and stderr use `Stdio::null()` because the host has no log
  consumer. This avoids a full-pipe deadlock.
- `stop()` checks for an already exited child, propagates kill failures and
  treats a bounded wait timeout as `sidecar_stop_failed`; it never reports a
  failed cleanup as success.
- A per-supervisor operation lock serializes concurrent `start()` and
  `stop()` calls. `Drop` performs best-effort idempotent cleanup.

## Resource layout

`scripts/build-local-agent-host.mjs` builds the local host and its workspace
runtime closure into a self-contained ESM directory. Tauri resources include
only `local-agent-host/dist/`, not the app source tree or workspace symlinks.
The Node host remains the existing safe Local Agent API entry; Task 23 does
not add provider calls, credentials, persistence, or shell/file tools.
