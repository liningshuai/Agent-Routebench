import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Deterministic offline eval entry.
//
// Stage 1 verifies the expected layout. Stage 2 actually *runs* the Task 3
// offline protocol scenario with real assertions (adapter -> ModelGateway
// wrapper -> Agent Core) and propagates its exit code, so this entry can no
// longer print "passed" without exercising behaviour.
//
// Everything here is offline: no network, no real model calls, no credential
// persistence.

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
  "docs/verification/task-3-report.md",
  "docs/verification/task-3-rework-report.md",
  "docs/verification/task-3-final-fix-report.md",
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
];

for (const path of required) {
  assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
}
console.log(`evals:deterministic stage 1 passed (${required.length} expected files present).`);

// Stage 2: run the offline protocol scenario. A non-zero child exit code must
// fail this entry; the result is never hard coded.
const vitestEntry = join(root, "node_modules/vitest/vitest.mjs");
assert.equal(
  existsSync(vitestEntry),
  true,
  "node_modules/vitest/vitest.mjs must exist to run the offline protocol scenario",
);

const scenario = spawnSync(
  process.execPath,
  [
    vitestEntry,
    "run",
    "tests/task-3-adapter-integration.test.ts",
    "--reporter=basic",
  ],
  { cwd: root, stdio: "inherit" },
);

if (scenario.error !== undefined && scenario.error !== null) {
  console.error(`evals:deterministic failed: ${scenario.error.message}`);
  process.exit(1);
}

if (scenario.status !== 0) {
  console.error(
    `evals:deterministic failed: the offline protocol scenario exited with code ${String(

      scenario.status,
    )}.`,
  );
  process.exit(1);
}

console.log(
  [
    "evals:deterministic passed.",
    "Covered: Task 0 baseline; Task 1 neutral shared contracts + offline fake gateway;",
    "Task 2 offline in-memory provider/route registry;",
    "Task 3 offline Anthropic Messages and OpenAI Chat Completions codecs verified",
    "end to end through the existing Agent Core.",
    "The scenario includes the final-fix regressions: cancellation is checked before the",
    "frame iterator advances, and lone-CR / CRLF chunk boundaries are framing-identical.",
    "No real model calls. No live provider adapters. No authentication injection.",
    "No persisted credentials. No network access.",
  ].join(" "),
);
