# Desktop Package

## Overview

The `@agent-workbench/desktop` package provides a Tauri-ready Desktop foundation with interactive UI, testable state management, dependency injection, and strict security boundaries for building the Agent Workbench desktop application.

**Current Status:** Interactive UI implemented in Task 15 with 57 focused tests across 9 files, building on the Task 14 foundation and its 139 Desktop tests.

## Architecture

### Design Principles

1. **Dependency Injection:** Desktop accesses the Local Agent API exclusively through the `DesktopApiClient` interface, enabling complete testability without external dependencies.

2. **Security Boundaries:** 
   - Desktop never directly accesses: model-gateway, provider-registry, credential-store, session-persistence, local-persistence, agent-runtime, or cc-switch-agent
   - All access goes through the injected API interface
   - ViewModels act as security filters, excluding sensitive data before UI rendering

3. **State Management:** Immutable state with defensive copying ensures predictable behavior and prevents accidental mutations.

4. **Cancellation:** AbortSignal-based cancellation for turn submission enables responsive UI and resource cleanup.

### Core Components

#### DesktopController

Central state manager coordinating connection, sessions, turns, and UI state.

```typescript
class DesktopController {
  constructor(apiClient: DesktopApiClient)
  
  getState(): DesktopState
  subscribe(callback: (state: Readonly<DesktopState>) => void): () => void
  connect(): Promise<void>
  createSession(): Promise<void>
  submitTurn(sessionId: string, request: LocalAgentTurnRequest): Promise<void>
  cancelTurn(sessionId: string): Promise<void>
  updateDraft(text: string): void
  clearError(): void
}
```

**State Machine:**
- `idle` → `loading` → `ready` (successful connection)
- `idle` → `loading` → `failed` (connection error)
- Reconnection supported after failure

**Subscription Mechanism:**
- `subscribe()` registers callbacks invoked on every state change
- Returns unsubscribe function for cleanup
- Enables reactive UI rendering

#### DesktopApiClient Interface

Abstraction boundary between Desktop and Local Agent API:

```typescript
interface DesktopApiClient {
  load(): Promise<void>
  createSession(): Promise<LocalAgentSession>
  submitTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent>
  cancelTurn(sessionId: string, turnId: string): Promise<void>
}
```

**Why Dependency Injection?**
- Complete unit testing without HTTP servers or file systems
- Clear security boundary enforcement
- Future implementation flexibility (HTTP, IPC, WebSocket)

#### ViewModel Layer

Security-critical transformation from internal `AgentEvent` to safe `EventViewModel`:

```typescript
function createEventViewModel(event: AgentEvent): EventViewModel
function renderEventToHtml(viewModel: EventViewModel): string
function escapeHtml(text: string): string
```

**Security Guarantees:**

1. **XSS Prevention:** All user-controlled and model-controlled text escaped via `escapeHtml` before rendering
2. **Credential Isolation:** `tool_call.input` deliberately excluded from ViewModels (may contain API keys, secrets)
3. **Provider Isolation:** `route_selected.routeId` and `.model` excluded (internal routing details)
4. **Fixed Error Messages:** Error messages don't echo user input

### Error Handling

Fixed error codes with structured `DesktopError`:

```typescript
const DESKTOP_ERROR_CODES = {
  NOT_CONNECTED: "not_connected",
  CONNECTION_FAILED: "connection_failed",
  SESSION_NOT_FOUND: "session_not_found",
  TURN_FAILED: "turn_failed",
  CANCEL_FAILED: "cancel_failed",
} as const;
```

## Security Model

### What Desktop Does NOT Do

- ❌ Does not implement Agent Loop
- ❌ Does not assemble model protocols
- ❌ Does not handle Provider authentication
- ❌ Does not read: process.env, CredentialStore, OS Keychain, filesystem, databases
- ❌ Does not use `innerHTML` with unescaped text

### Security Boundaries

```
Desktop (UI)
  ↓ DesktopApiClient interface
Local Agent API
  ↓
Agent Runtime → Model Gateway → Provider Registry → Credential Store
```

**Enforced Isolation:**
- Desktop only sees `AgentEvent` streams
- Credentials never leave credential-store
- Provider URLs never enter ViewModels
- `tool_call.input` never reaches UI

## Testing

### Test Coverage

**196 tests across 16 Desktop test suites:**

**Task 15 - Interactive UI (57 tests):**
- `task-15-desktop-ui-mount.test.ts` (9 tests): Mount function, DOM creation, controller integration
- `task-15-desktop-ui-connect.test.ts` (9 tests): Connection button, state updates, error handling
- `task-15-desktop-ui-session.test.ts` (8 tests): Session creation, activation, list rendering
- `task-15-desktop-ui-draft.test.ts` (5 tests): Draft input, state sync, send button logic
- `task-15-desktop-ui-xss.test.ts` (8 tests): HTML escaping, script prevention, entity encoding
- `task-15-desktop-ui-cancel.test.ts` (6 tests): Cancel button, draft restoration, abort handling
- `task-15-desktop-ui-subscribe.test.ts` (8 tests): Subscription callbacks, unsubscribe, reactive rendering
- `task-15-desktop-ui-lifecycle.test.ts` (2 tests): Session switching and late-render prevention after unmount
- `task-15-desktop-ui-entry.test.ts` (2 tests): Browser entry script and injected client bootstrap

**Task 14 - Foundation (120 tests):**
- `task-14-desktop-state.test.ts` (20 tests): State structure and transitions
- `task-14-desktop-controller.test.ts` (20 tests): Controller behavior
- `task-14-desktop-security.test.ts` (18 tests): Security boundaries
- `task-14-desktop-xss.test.ts` (16 tests): XSS attack vectors
- `task-14-desktop-edge-cases.test.ts` (17 tests): Edge cases and error handling
- `task-14-desktop-rendering.test.ts` (29 tests): Pure renderer function, HTML structure, determinism
- Task 14 error-sanitization closeout adds 19 tests in `task-14-desktop-error-sanitization.test.ts`.

### TDD Methodology

Both Task 14 and Task 15 followed strict Red-Green-Refactor:
1. **Red:** Write failing tests first
2. **Green:** Implement minimal code to pass
3. **Refactor:** Improve design while keeping tests green

### Mutation Testing

**Task 15:** The original mutation notes are retained as historical evidence.
The repair added session/lifecycle/browser-entry regression tests; this repair
did not rerun the historical mutation suite, so no new detection rate is claimed.

**Task 14:** 10 controlled mutations with 80.0% detection rate (8/10 detected)
- Security boundaries: 100% detection (4/4 mutations)
- State management: 100% detection (3/3 mutations)
- Input validation: 100% detection (1/1 mutation)
- Resource cleanup: 0% detection (1/1 mutation - minor gap)
- Error type validation: 0% detection (1/1 mutation - minor gap)

See `docs/verification/task-15-mutations.md` and `docs/verification/task-14-mutations.md` for detailed results.

### Test Fixtures

`FakeDesktopApiClient` enables complete unit testing:
- Controllable behavior (success/failure modes)
- Event streaming simulation
- AbortSignal integration
- No external dependencies

## Usage Example

### Interactive UI (Task 15)

```typescript
import { mountDesktopUi } from "@agent-workbench/desktop";
import type { DesktopApiClient } from "@agent-workbench/desktop";

// The host supplies this bridge. The renderer does not create a network client.
declare const apiClient: DesktopApiClient;

// Mount interactive UI to DOM container
const container = document.getElementById("app")!;
const ui = mountDesktopUi(container, apiClient);

// Subscribe to state changes (optional)
const unsubscribe = ui.subscribe((state) => {
  console.log("State updated:", state.connection, state.activeSessionId);
});

// Cleanup: unmount also unsubscribes the internal renderer and aborts an
// in-flight submission. Late API results cannot repopulate the container.
unsubscribe();
ui.unmount();
```

### Browser entry

`public/index.html` loads the compiled `dist/browser-entry.js`. A Tauri host
or another local shell must inject a `DesktopApiClient` on
`globalThis.__AGENT_WORKBENCH_DESKTOP_API_CLIENT__` before the module loads.
The entry performs no network access and does nothing when the host has not
provided a valid bridge. Tests can use `bootstrapDesktopUi(container, client)`
directly.

**Interactive Features:**
- Connect button initiates connection to Local Agent API
- New Session button creates sessions
- Draft textarea with real-time state updates
- Send button (disabled when draft empty, enabled when draft has content)
- Cancel button during submission (preserves draft on cancel)
- Streaming event display
- XSS protection with HTML escaping

### Controller API (Task 14)

```typescript
import { DesktopController } from "@agent-workbench/desktop";
import { RealDesktopApiClient } from "./real-client";

// Create controller with injected client
const apiClient = new RealDesktopApiClient("http://127.0.0.1:4317");
const controller = new DesktopController(apiClient);

// Connect to Local Agent API
await controller.connect();
const state = controller.getState();
console.log(state.connection); // "ready"

// Create session
await controller.createSession();

// Submit turn with cancellation support
const sessionId = controller.getState().activeSessionId!;
await controller.submitTurn(sessionId, {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
});

// Cancel if needed
controller.cancelTurn(sessionId);
```

## Future Work

### Tauri Integration

Desktop package is designed for Tauri but not yet integrated:

1. **IPC DesktopApiClient:** Implement `DesktopApiClient` using Tauri IPC commands
2. **Renderer Process:** Use `mountDesktopUi()` in Tauri's frontend (already interactive)
3. **Bundle Integration:** Tauri build system consumes compiled ESM output from `dist/`
4. **Native Features:** File dialogs, system tray, menu bar via Tauri APIs

### Test Coverage Improvements

From Task 14 mutation testing:
1. Add test verifying AbortController cleanup after turn completion
2. Add tests checking `error instanceof DesktopError` and `error.code`

Task 15's original mutation notes are historical evidence. The repair added
focused regression coverage for session switching, browser bootstrapping and
late-render prevention; mutation results are not reported as rerun unless the
controlled mutation has actually been executed.

### Build Strategy

**Current (Task 15):** Native ESM with TypeScript compilation
- TypeScript compiles `src/` → `dist/`
- Package exports `./dist/index.js`
- No bundler required (Tauri handles final bundling)

**Future Options:**
- Add esbuild/rollup for minification and tree-shaking
- Generate source maps for production debugging
- Bundle CSS into JS for single-file distribution

## Dependencies

- `@agent-workbench/agent-core`: Core types (`AgentEvent`)
- `@agent-workbench/local-agent-api`: API types (`LocalAgentSession`, `LocalAgentTurnRequest`)

## Package Structure

```
apps/desktop/
├── src/
│   ├── index.ts           # Public exports
│   ├── types.ts           # DesktopState, DesktopApiClient
│   ├── errors.ts          # DesktopError, error codes
│   ├── controller.ts      # DesktopController with subscription
│   ├── view-model.ts      # ViewModel, escapeHtml, rendering
│   ├── render.ts          # Pure renderer: renderDesktopPage(state)
│   ├── ui.ts              # Interactive UI: mountDesktopUi(container, client)
│   └── browser-entry.ts   # Host-injected browser bootstrap
├── dist/                  # Compiled JavaScript output (ESM)
│   ├── controller.js
│   ├── errors.js
│   ├── index.js
│   ├── render.js
│   ├── types.js
│   ├── ui.js
│   ├── browser-entry.js
│   └── view-model.js
├── public/
│   ├── index.html         # Static Desktop page foundation
│   └── styles.css         # Complete styling
├── package.json           # Exports: ./dist/index.js
└── tsconfig.json          # Build config (noEmit: false)
```

## See Also

- [Task 15 Verification Report](./verification/task-15-report.md)
- [Task 15 Mutation Testing](./verification/task-15-mutations.md)
- [Task 14 Verification Report](./verification/task-14-report.md)
- [Task 14 Mutation Testing](./verification/task-14-mutations.md)
- [Local Agent API](./local-agent-api.md)
