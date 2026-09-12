# Task 17 Verification Report: Tauri Desktop IPC Bridge MVP

## Scope

Task 17 adds a dependency-injected TypeScript bridge from Tauri-style
invoke/listen functions to the existing DesktopApiClient interface. It
does not add a Tauri package, Rust host code, provider calls, credentials or
remote networking.

## Deliverables

- apps/desktop/src/tauri-api-client.ts: fixed command/event adapter,
  response validation, event filtering, safe error normalization and
  cancellation-aware async iteration;
- apps/desktop/src/index.ts: public exports for the bridge contract;
- apps/desktop/src/errors.ts: fixed Session creation error;
- Task 17 command, security, lifecycle and cancellation tests;
- docs/tauri.md: host wiring and IPC contract.

## Verification evidence

The initial focused test run failed during collection because
tauri-api-client.ts did not exist. After implementation, the focused suite
contains 28 tests across 3 files, all passing:

- command mapping and event filtering: 6;
- IPC validation and security: 12;
- lifecycle, concurrent streams and cancellation: 10.

The bridge was also checked with the full TypeScript typecheck. Tests cover
pre-cancellation, pending listener/start operations, terminal events,
early iterator cleanup, concurrent session isolation, malformed host data,
fixed error messages, request field rejection and error-event sanitization.

The Desktop package build also completed successfully with the bridge exported
through the package entry point. The deterministic evaluation ran the Task 17
scenario together with the prior Task 0-16 scenarios.

## Security boundaries

- only the fixed four invoke commands and one event name are used;
- turn requests accept only the existing Local Agent API fields;
- sensitive or unknown request fields are rejected before host invocation;
- host errors and error-event messages never expose their original text;
- event envelopes are filtered by session and turn identifiers;
- no Provider, CredentialStore, persistence or remote network code is used;
- no @tauri-apps/api or other runtime dependency was added.

## Validation commands

The following checks were run after the implementation:

~~~text
corepack pnpm install --frozen-lockfile
corepack pnpm verify:layout
corepack pnpm typecheck
corepack pnpm build:desktop
node node_modules/vitest/vitest.mjs run
  tests/task-17-tauri-bridge.test.ts
  tests/task-17-tauri-bridge-security.test.ts
  tests/task-17-tauri-bridge-cancellation.test.ts
corepack pnpm test
corepack pnpm security:scan
corepack pnpm evals:deterministic
git diff --check
~~~

All listed checks exited with code 0. The focused suite reported Test Files 3
passed (3) and Tests 28 passed (28). The full suite reported Test Files 73
passed (73) and Tests 1447 passed (1447). The security scan reported 260 files
scanned; the deterministic evaluation reported stage 1 with 234 expected files
and a passing Task 17 scenario.

## Explicit non-goals

No Rust Tauri project, permission manifest, native window lifecycle,
filesystem dialog, tray integration, real Provider call or credential access
is included in Task 17.
