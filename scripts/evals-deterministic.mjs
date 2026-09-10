import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Deterministic offline eval entry. Covers the Task 0 engineering baseline, the
// Task 1 neutral contracts + offline gateway, and the Task 2 in-memory
// provider/route registry. No network, no model calls, no provider adapters and
// no credential persistence.
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
];

for (const path of required) {
  assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
}

console.log(
  [
    "evals:deterministic passed.",
    "Covered: Task 0 baseline, Task 1 neutral shared contracts + offline fake gateway,",
    "Task 2 offline in-memory provider/route registry and package-boundary files.",
    "No real model calls. No provider adapters. No persisted credentials. No network access.",
  ].join(" "),
);
