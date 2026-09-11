# Desktop Package

## Overview

The `@agent-workbench/desktop` package provides a Tauri-ready Desktop foundation with testable state management, dependency injection, and strict security boundaries for building the Agent Workbench desktop application.

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
  connect(): Promise<void>
  newSession(): Promise<void>
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

**91 tests across 5 test suites:**
- `task-14-desktop-state.test.ts` (20 tests): State structure and transitions
- `task-14-desktop-controller.test.ts` (20 tests): Controller behavior
- `task-14-desktop-security.test.ts` (18 tests): Security boundaries
- `task-14-desktop-xss.test.ts` (16 tests): XSS attack vectors
- `task-14-desktop-edge-cases.test.ts` (17 tests): Edge cases and error handling

### TDD Methodology

Task 14 followed strict Red-Green-Refactor:
1. **Red:** Write failing tests first
2. **Green:** Implement minimal code to pass
3. **Refactor:** Improve design while keeping tests green

### Mutation Testing

9 controlled mutations executed with 77.8% detection rate:
- Security boundaries: 100% detection (3/3 mutations)
- State management: 100% detection (3/3 mutations)
- Input validation: 100% detection (1/1 mutation)
- Resource cleanup: 0% detection (1/1 mutation - minor gap)
- Error type validation: 0% detection (1/1 mutation - minor gap)

See `docs/verification/task-14-mutations.md` for detailed mutation testing results.

### Test Fixtures

`FakeDesktopApiClient` enables complete unit testing:
- Controllable behavior (success/failure modes)
- Event streaming simulation
- AbortSignal integration
- No external dependencies

## Usage Example

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
await controller.newSession();

// Submit turn with cancellation support
const sessionId = controller.getState().activeSessionId!;
await controller.submitTurn(sessionId, {
  messages: [{ role: "user", content: "Hello!" }],
});

// Cancel if needed
controller.cancelTurn(sessionId);
```

## Future Work

### Tauri Integration

Desktop package is designed for Tauri but not yet integrated:

1. **IPC DesktopApiClient:** Implement `DesktopApiClient` using Tauri IPC commands
2. **Renderer Process:** Use `DesktopController` in Tauri's frontend
3. **State Binding:** Connect `getState()` to UI framework (React, Vue, Svelte)
4. **HTML Rendering:** Use `renderEventToHtml()` for event display

### Test Coverage Improvements

From mutation testing:
1. Add test verifying AbortController cleanup after turn completion
2. Add tests checking `error instanceof DesktopError` and `error.code`

### UI Features

Desktop package provides state management foundation; UI implementation remains:
- Message list rendering
- Draft input
- Session switcher
- Error display
- Progress indicators

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
│   ├── controller.ts      # DesktopController
│   └── view-model.ts      # ViewModel, escapeHtml, rendering
├── package.json
└── tsconfig.json
```

## See Also

- [Task 14 Verification Report](./verification/task-14-report.md)
- [Mutation Testing Results](./verification/task-14-mutations.md)
- [Local Agent API](./local-agent-api.md)
