# Shared Local Agent API Client

## Purpose

`@agent-workbench/local-agent-client` is the shared HTTP client for the loopback
Local Agent API. The CLI and Desktop packages use this client so URL handling,
response validation, NDJSON streaming, limits, errors and cancellation have one
implementation and one security boundary.

Task 16 does not add Tauri IPC, a remote server, provider calls or credentials.
The client accepts only `http://127.0.0.1` and `http://localhost` base URLs.

## Public surface

- `LocalAgentApiClient` and `createLocalAgentApiClient()`
- `health()`, `createSession()`, `getSession()`, `listEvents()`, `runTurn()` and
  `cancel()`
- `parseNDJSONStream()` and `validateAgentEvent()`
- `normalizeLoopbackBaseUrl()` and `encodePathSegment()`
- fixed `LocalAgentClientError` codes and messages

The constructor supports an injected `fetch` implementation. Production can use
the runtime's native `fetch`; tests use a fake. No authentication headers are
constructed or accepted by this package.

## Protocol boundary

JSON endpoints send `application/json` only for POST requests. Session responses
may be either the API's `{ "session": ... }` envelope or a session object; event
responses may be either an `{ "events": [...] }` envelope or an array. Both
forms are validated before being returned.

Turn responses are newline-delimited JSON. The parser:

- decodes UTF-8 with fatal error handling;
- validates every event's exact shape;
- requires exactly a terminal `completed` or `error` event;
- rejects data after a terminal event;
- enforces independent line and total byte limits;
- supports both `(stream, signal, limits)` and the CLI-compatible
  `(stream, limits)` call form.

The client never copies provider URLs, route credentials or authentication data
into a request body, event, or error. Unknown turn fields are rejected before
`fetch` is called.

## Cancellation and cleanup

Every network operation receives the caller's `AbortSignal`. A pending fetch or
body read is raced against cancellation so an abort does not wait for a provider
or server promise to settle. Late rejection is consumed, and a late response
body is cancelled without being read. Streaming readers are released on normal
completion, protocol failure, early consumer exit and cancellation.

Cancellation is reported with the fixed `aborted` error code. The client does
not retry, fail over, persist sessions or read credentials.

## Package boundaries

```text
CLI ───────┐
           ├─ @agent-workbench/local-agent-client ── local-agent-api types
Desktop ───┘
```

The shared package depends only on `@agent-workbench/agent-core` for event types
and `@agent-workbench/local-agent-api` for session/turn types. It does not depend
on model gateways, provider registries, persistence, runtime tools or Tauri.

Desktop's `createLoopbackDesktopApiClient()` adapts the shared client to the
existing `DesktopApiClient` interface. The adapter is tested both with injected
responses and against a real `127.0.0.1` Local Agent API server. That integration
is still local-only; no external network is used.

## Verification

Task 16 tests cover URL restrictions, request construction, envelope validation,
fatal UTF-8, NDJSON limits and termination, fixed errors, late promise cleanup,
Desktop adaptation and real loopback integration. All HTTP unit tests inject a
fake fetch; the two integration tests connect only to a temporary local server.
