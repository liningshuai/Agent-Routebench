import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Deterministic offline eval entry.
//
// Stage 1 verifies the expected layout.
// Stage 2 actually *runs* the offline Task 3 protocol scenario and the offline
// Task 4 routed HTTP scenario, and propagates their exit codes so this entry can
// never print "passed" without exercising behaviour.
//
// Everything here is offline: the routed HTTP transport is always driven by an
// injected fake client, so no provider is contacted and no real network access
// happens. No credential is persisted anywhere.

const required = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "vitest.config.ts",
  "LICENSE",
  "NOTICE",
  "README.md",
  "docs/architecture.md",
  "docs/licensing.md",
  "docs/protocol-adapters.md",
  "docs/http-transport.md",
  "docs/verification/task-3-report.md",
  "docs/verification/task-3-rework-report.md",
  "docs/verification/task-3-final-fix-report.md",
  "docs/verification/task-4-report.md",
  "docs/resilience.md",
  "docs/verification/task-5-report.md",
  "docs/agent-runtime.md",
  "docs/verification/task-6-report.md",
  "docs/tool-policy.md",
  "docs/verification/task-7-report.md",
  "docs/local-persistence.md",
  "docs/verification/task-8-report.md",
  "docs/local-agent-api.md",
  "docs/verification/task-9-report.md",
  "docs/provider-discovery.md",
  "docs/verification/task-10-report.md",
  "docs/session-persistence.md",
  "docs/verification/task-11-report.md",
  "docs/memory.md",
  "docs/verification/task-12-report.md",
  "scripts/verify-layout.mjs",
  "packages/agent-contracts/package.json",
  "packages/agent-contracts/src/contracts.ts",
  "packages/agent-contracts/src/gateway-contracts.ts",
  "packages/agent-contracts/src/index.ts",
  "packages/agent-core/package.json",
  "packages/agent-core/src/contracts.ts",
  "packages/agent-core/src/agent-core.ts",
  "packages/agent-core/src/index.ts",
  "packages/model-gateway/package.json",
  "packages/model-gateway/src/contracts.ts",
  "packages/model-gateway/src/fake-gateway.ts",
  "packages/model-gateway/src/http-transport.ts",
  "packages/model-gateway/src/candidate-attempt.ts",
  "packages/model-gateway/src/routed-http-gateway.ts",
  "packages/model-gateway/src/resilience.ts",
  "packages/model-gateway/src/resilient-routed-gateway.ts",
  "packages/model-gateway/src/index.ts",
  "packages/model-gateway/src/adapters/index.ts",
  "packages/model-gateway/src/adapters/types.ts",
  "packages/model-gateway/src/adapters/errors.ts",
  "packages/model-gateway/src/adapters/request-validation.ts",
  "packages/model-gateway/src/adapters/sse.ts",
  "packages/model-gateway/src/adapters/anthropic-request.ts",
  "packages/model-gateway/src/adapters/anthropic-stream.ts",
  "packages/model-gateway/src/adapters/openai-chat-request.ts",
  "packages/model-gateway/src/adapters/openai-chat-stream.ts",
  "packages/model-gateway/src/adapters/stream-runtime.ts",
  "packages/model-gateway/src/adapters/decode-utils.ts",
  "packages/provider-registry/package.json",
  "packages/provider-registry/src/types.ts",
  "packages/provider-registry/src/errors.ts",
  "packages/provider-registry/src/credential-store.ts",
  "packages/provider-registry/src/presets.ts",
  "packages/provider-registry/src/registry.ts",
  "packages/provider-registry/src/index.ts",
  "packages/agent-runtime/package.json",
  "packages/agent-runtime/tsconfig.json",
  "packages/agent-runtime/src/types.ts",
  "packages/agent-runtime/src/errors.ts",
  "packages/agent-runtime/src/agent-loop.ts",
  "packages/agent-runtime/src/index.ts",
  "packages/local-persistence/package.json",
  "packages/local-persistence/tsconfig.json",
  "packages/local-persistence/src/types.ts",
  "packages/local-persistence/src/errors.ts",
  "packages/local-persistence/src/snapshot.ts",
  "packages/local-persistence/src/json-store.ts",
  "packages/local-persistence/src/file-store.ts",
  "packages/local-persistence/src/index.ts",
  "packages/local-agent-api/package.json",
  "packages/local-agent-api/tsconfig.json",
  "packages/local-agent-api/src/types.ts",
  "packages/local-agent-api/src/errors.ts",
  "packages/local-agent-api/src/validation.ts",
  "packages/local-agent-api/src/session-store.ts",
  "packages/local-agent-api/src/ndjson.ts",
  "packages/local-agent-api/src/server.ts",
  "packages/local-agent-api/src/index.ts",
  "packages/provider-discovery/package.json",
  "packages/provider-discovery/tsconfig.json",
  "packages/provider-discovery/src/types.ts",
  "packages/provider-discovery/src/errors.ts",
  "packages/provider-discovery/src/parse.ts",
  "packages/provider-discovery/src/discovery.ts",
  "packages/provider-discovery/src/index.ts",
  "packages/session-persistence/package.json",
  "packages/session-persistence/tsconfig.json",
  "packages/session-persistence/src/types.ts",
  "packages/session-persistence/src/errors.ts",
  "packages/session-persistence/src/crypto.ts",
  "packages/session-persistence/src/validation.ts",
  "packages/session-persistence/src/file-session-store.ts",
  "packages/session-persistence/src/index.ts",
  "packages/agent-memory/package.json",
  "packages/agent-memory/tsconfig.json",
  "packages/agent-memory/src/types.ts",
  "packages/agent-memory/src/errors.ts",
  "packages/agent-memory/src/memory-store.ts",
  "packages/agent-memory/src/context-validation.ts",
  "packages/agent-memory/src/context-builder.ts",
  "packages/agent-memory/src/index.ts",
  "apps/cli/package.json",
  "apps/cli/tsconfig.json",
  "apps/cli/src/index.ts",
  "apps/cli/src/main.ts",
  "apps/cli/src/cli.ts",
  "apps/cli/src/args.ts",
  "apps/cli/src/api-client.ts",
  "apps/cli/src/ndjson.ts",
  "apps/cli/src/errors.ts",
  "docs/cli.md",
  "docs/verification/task-13-report.md",
  "tests/helpers/cli-fixtures.ts",
  "tests/task-13-cli-args.test.ts",
  "tests/task-13-cli-client.test.ts",
  "tests/task-13-cli-streaming.test.ts",
  "tests/task-13-cli-security.test.ts",
  "tests/task-13-cli-integration.test.ts",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "apps/desktop/src/index.ts",
  "apps/desktop/src/types.ts",
  "apps/desktop/src/errors.ts",
  "apps/desktop/src/controller.ts",
  "apps/desktop/src/view-model.ts",
  "apps/desktop/src/render.ts",
  "apps/desktop/src/ui.ts",
  "apps/desktop/src/browser-entry.ts",
  "apps/desktop/public/index.html",
  "apps/desktop/public/styles.css",
  "docs/desktop.md",
  "docs/verification/task-14-report.md",
  "docs/verification/task-14-mutations.md",
  "docs/verification/task-15-report.md",
  "docs/verification/task-15-mutations.md",
  "docs/verification/task-15-final-fix-report.md",
  "tests/helpers/desktop-fixtures.ts",
  "tests/task-14-desktop-state.test.ts",
  "tests/task-14-desktop-controller.test.ts",
  "tests/task-14-desktop-security.test.ts",
  "tests/task-14-desktop-xss.test.ts",
  "tests/task-14-desktop-edge-cases.test.ts",
  "tests/task-14-desktop-rendering.test.ts",
  "tests/task-15-desktop-ui-mount.test.ts",
  "tests/task-15-desktop-ui-connect.test.ts",
  "tests/task-15-desktop-ui-session.test.ts",
  "tests/task-15-desktop-ui-draft.test.ts",
  "tests/task-15-desktop-ui-xss.test.ts",
  "tests/task-15-desktop-ui-cancel.test.ts",
  "tests/task-15-desktop-ui-subscribe.test.ts",
  "tests/task-15-desktop-ui-lifecycle.test.ts",
  "tests/task-15-desktop-ui-entry.test.ts",
  "tests/helpers/adapter-fixtures.ts",
  "tests/helpers/http-fixtures.ts",
  "tests/helpers/runtime-fixtures.ts",
  "tests/task-1-package-boundary.test.ts",
  "tests/task-1-agent-contracts.test.ts",
  "tests/task-1-fake-gateway.test.ts",
  "tests/task-1-agent-core.test.ts",
  "tests/task-2-provider-registry.test.ts",
  "tests/task-2-provider-security.test.ts",
  "tests/task-3-adapter-requests.test.ts",
  "tests/task-3-sse.test.ts",
  "tests/task-3-anthropic-stream.test.ts",
  "tests/task-3-openai-chat-stream.test.ts",
  "tests/task-3-adapter-integration.test.ts",
  "tests/task-4-http-gateway.test.ts",
  "tests/task-4-http-security.test.ts",
  "tests/task-4-http-integration.test.ts",
  "tests/task-5-provider-candidates.test.ts",
  "tests/task-5-resilience.test.ts",
  "tests/task-5-resilience-security.test.ts",
  "tests/task-6-agent-runtime.test.ts",
  "tests/task-6-agent-runtime-security.test.ts",
  "tests/task-6-agent-runtime-cancellation.test.ts",
  "tests/task-7-tool-policy.test.ts",
  "tests/task-7-tool-policy-security.test.ts",
  "tests/task-7-tool-policy-cancellation.test.ts",
  "tests/task-8-persistence-snapshot.test.ts",
  "tests/task-8-persistence-file.test.ts",
  "tests/task-8-persistence-security.test.ts",
  "tests/task-8-persistence-concurrency.test.ts",
  "tests/helpers/local-agent-api-fixtures.ts",
  "tests/task-9-local-api.test.ts",
  "tests/task-9-local-api-streaming.test.ts",
  "tests/task-9-local-api-security.test.ts",
  "tests/task-9-local-api-concurrency.test.ts",
  "tests/helpers/provider-discovery-fixtures.ts",
  "tests/task-10-provider-discovery.test.ts",
  "tests/task-10-provider-discovery-security.test.ts",
  "tests/task-10-provider-discovery-cancellation.test.ts",
  "tests/task-10-provider-discovery-protocol.test.ts",
  "tests/helpers/session-persistence-fixtures.ts",
  "tests/task-11-session-persistence.test.ts",
  "tests/task-11-session-persistence-security.test.ts",
  "tests/task-11-session-persistence-recovery.test.ts",
  "tests/task-11-session-persistence-concurrency.test.ts",
  "tests/helpers/memory-fixtures.ts",
  "tests/task-12-memory-store.test.ts",
  "tests/task-12-context-compaction.test.ts",
  "tests/task-12-memory-security.test.ts",
  "tests/task-12-context-cancellation.test.ts",
];

for (const path of required) {
  assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
}
console.log(
  `evals:deterministic stage 1 passed (${required.length} expected files present).`,
);

const vitestEntry = join(root, "node_modules/vitest/vitest.mjs");
assert.equal(
  existsSync(vitestEntry),
  true,
  "node_modules/vitest/vitest.mjs must exist to run the offline protocol scenarios",
);

/** Runs one offline scenario. A non-zero child exit code fails this entry. */
function runScenario(label, files) {
  const result = spawnSync(
    process.execPath,
    [vitestEntry, "run", ...files, "--reporter=basic"],
    { cwd: root, stdio: "inherit" },
  );

  if (result.error !== undefined && result.error !== null) {
    console.error(`evals:deterministic failed (${label}): ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(
      `evals:deterministic failed (${label}): the offline scenario exited with code ${String(
        result.status,
      )}.`,
    );
    process.exit(1);
  }

  console.log(`evals:deterministic stage 2 scenario passed (${label}).`);
}

runScenario("task 3 protocol codecs", ["tests/task-3-adapter-integration.test.ts"]);

runScenario("task 4 routed HTTP transport", [
  "tests/task-4-http-gateway.test.ts",
  "tests/task-4-http-security.test.ts",
  "tests/task-4-http-integration.test.ts",
]);

runScenario("task 5 retry and failover", [
  "tests/task-5-provider-candidates.test.ts",
  "tests/task-5-resilience.test.ts",
  "tests/task-5-resilience-security.test.ts",
]);

runScenario("task 6 agent loop and tool boundary", [
  "tests/task-6-agent-runtime.test.ts",
  "tests/task-6-agent-runtime-security.test.ts",
  "tests/task-6-agent-runtime-cancellation.test.ts",
]);

runScenario("task 7 tool policy and approval gate", [
  "tests/task-7-tool-policy.test.ts",
  "tests/task-7-tool-policy-security.test.ts",
  "tests/task-7-tool-policy-cancellation.test.ts",
]);

runScenario("task 8 non-secret config persistence", [
  "tests/task-8-persistence-snapshot.test.ts",
  "tests/task-8-persistence-file.test.ts",
  "tests/task-8-persistence-security.test.ts",
  "tests/task-8-persistence-concurrency.test.ts",
]);

runScenario("task 9 local agent API", [
  "tests/task-9-local-api.test.ts",
  "tests/task-9-local-api-streaming.test.ts",
  "tests/task-9-local-api-security.test.ts",
  "tests/task-9-local-api-concurrency.test.ts",
]);

runScenario("task 10 provider discovery", [
  "tests/task-10-provider-discovery.test.ts",
  "tests/task-10-provider-discovery-protocol.test.ts",
  "tests/task-10-provider-discovery-security.test.ts",
  "tests/task-10-provider-discovery-cancellation.test.ts",
]);

runScenario("task 11 encrypted session persistence", [
  "tests/task-11-session-persistence.test.ts",
  "tests/task-11-session-persistence-security.test.ts",
  "tests/task-11-session-persistence-recovery.test.ts",
  "tests/task-11-session-persistence-concurrency.test.ts",
]);

runScenario("task 12 memory and context compaction", [
  "tests/task-12-memory-store.test.ts",
  "tests/task-12-context-compaction.test.ts",
  "tests/task-12-memory-security.test.ts",
  "tests/task-12-context-cancellation.test.ts",
]);

runScenario("task 13 node CLI for local agent API", [
  "tests/task-13-cli-args.test.ts",
  "tests/task-13-cli-client.test.ts",
  "tests/task-13-cli-streaming.test.ts",
  "tests/task-13-cli-security.test.ts",
  "tests/task-13-cli-integration.test.ts",
]);

runScenario("task 14 desktop renderer shell", [
  "tests/task-14-desktop-state.test.ts",
  "tests/task-14-desktop-controller.test.ts",
  "tests/task-14-desktop-security.test.ts",
  "tests/task-14-desktop-xss.test.ts",
  "tests/task-14-desktop-edge-cases.test.ts",
  "tests/task-14-desktop-rendering.test.ts",
]);

runScenario("task 15 desktop interactive UI", [
  "tests/task-15-desktop-ui-mount.test.ts",
  "tests/task-15-desktop-ui-connect.test.ts",
  "tests/task-15-desktop-ui-session.test.ts",
  "tests/task-15-desktop-ui-draft.test.ts",
  "tests/task-15-desktop-ui-xss.test.ts",
  "tests/task-15-desktop-ui-cancel.test.ts",
  "tests/task-15-desktop-ui-subscribe.test.ts",
  "tests/task-15-desktop-ui-lifecycle.test.ts",
  "tests/task-15-desktop-ui-entry.test.ts",
]);

console.log(
  [
    "evals:deterministic passed.",
    "Covered: Task 0 baseline; Task 1 neutral shared contracts + offline fake gateway;",
    "Task 2 offline in-memory provider/route registry;",
    "Task 3 offline Anthropic Messages and OpenAI Chat Completions codecs;",
    "Task 4 routed HTTP transport verified end to end through the existing Agent Core.",
    "The routed transport is always exercised with an injected fake HTTP client, which",
    "verifies route resolution, the credential reference boundary, request construction,",
    "HTTP status mapping and incremental offline streaming.",
    "Task 5 adds ordered provider candidates, a bounded retry and an ordered failover,",
    "verified offline through the same injected fake client and an injected wait;",
    "a retry or a switch is refused once an attempt has produced visible output.",
    "No real provider calls. No real network access. Authentication headers are exercised",
    "only by the injected fake HTTP client; nothing is sent to a real provider.",
    "No persisted credentials.",
    "Task 6 adds a bounded multi-turn agent loop with an injected ToolExecutor boundary:",
    "the runtime ships no tool at all, so the offline scenarios drive it with an injected",
    "fake executor and there is no shell tool, no file tool and no network tool anywhere",
    "in the runtime. Every model request is answered from a scripted offline gateway, so",
    "no real model call happens either.",
    "Task 7 adds the injected ToolPolicy and ToolApprovalHandler gate in front of that",
    "executor: it fails closed when no policy is supplied, executes a tool only after an",
    "explicit 'approved' verdict, and collapses every policy, approval or executor failure",
    "into a fixed safe result. The policy, the approval handler and the executor in these",
    "scenarios are all injected fakes; there is no real tool, no approval persistence, no",
    "remember-decision mechanism, no approval UI and no network access.",
    "Task 8 adds versioned non-secret provider/route config persistence: snapshot creation",
    "and validation, an in-memory JSON store, an atomic file store (sibling temp + rename),",
    "and registry load/save. Secrets, CredentialStore values, API keys, tokens and",
    "Authorization headers are never written to a snapshot or a file. The file scenarios",
    "use temporary directories only; no network access happens and no real provider is",
    "contacted.",
    "Task 9 adds the loopback-only Local Agent API: session lifecycle, an injected",
    "LocalAgentRunner, NDJSON incremental event streaming, per-session cancellation and",
    "fixed safe errors. The scenarios bind only 127.0.0.1, never call a real provider,",
    "never read a CredentialStore and never persist a session to disk.",
    "Task 10 adds offline provider health checks and model catalog discovery: Anthropic",
    "/v1/models and OpenAI-compatible /models are exercised only through an injected fake",
    "HttpClient. Credentials are read at most once per call and never written; the",
    "registry is never mutated; no real provider is contacted; no cache, retry or",
    "failover is performed.",
    "Task 11 adds encrypted local session persistence: LocalAgentSession metadata and",
    "AgentEvent history are stored in an AES-256-GCM envelope file. The encryption key is",
    "injected by the caller and never written to disk. Writes are atomic (sibling temp +",
    "rename) with memory rollback on failure. On load, sessions left in 'running' are",
    "recovered to 'failed'. No network access, no CredentialStore, no real provider.",
    "Task 12 adds in-process memory and deterministic context compaction: a MemoryStore",
    "with explicit caller-provided entries and deterministic text search, plus a context",
    "builder that compresses by UTF-8 byte budget using an injected fake summarizer.",
    "No real model summarization, no persistence, no network, no CredentialStore.",
    "Task 13 adds the Node CLI for Local Agent API: a type-safe LocalAgentApiClient, NDJSON",
    "streaming parser with UTF-8 fatal validation and size limits, strict loopback-only URL",
    "enforcement, rejection of 14 sensitive parameters, fixed error codes and messages, and",
    "complete AbortSignal cancellation. All 131 tests use injected fake fetch and stdio;",
    "integration tests exercise real LocalAgentApiServer instances. No remote network, no",
    "real provider, no persisted credentials.",
    "Task 14 adds the Desktop Renderer Shell: a Tauri-ready foundation with DesktopController",
    "state management, DesktopApiClient interface boundary for dependency injection, a",
    "security-hardened ViewModel layer, and a pure function Renderer (renderDesktopPage(state):",
    "string). XSS prevention through HTML escaping, credential isolation (tool_call.input",
    "excluded), provider information isolation, and fixed error messages. Task 15 adds the",
    "interactive mount, session switching, cancellation lifecycle, browser entry bootstrap and",
    "late-update protection; its focused suite has 57 tests across 9 files. Desktop accesses",
    "Local Agent API only through the injected interface; it never directly touches",
    "model-gateway, provider-registry, credential-store, session-persistence, or agent-runtime.",
    "No real provider, no network, no persisted credentials.",
  ].join(" "),
);
