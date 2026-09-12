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
