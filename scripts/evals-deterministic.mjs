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
  ].join(" "),
);
