import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Deterministic offline eval entry. Covers Task 0 engineering baseline and
// Task 1 shared contracts + offline gateway files. No network, no model calls.
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
  "packages/agent-core/package.json",
  "packages/agent-core/src/contracts.ts",
  "packages/agent-core/src/agent-core.ts",
  "packages/agent-core/src/index.ts",
  "packages/model-gateway/package.json",
  "packages/model-gateway/src/contracts.ts",
  "packages/model-gateway/src/fake-gateway.ts",
  "packages/model-gateway/src/index.ts",
  "tests/task-1-agent-contracts.test.ts",
  "tests/task-1-fake-gateway.test.ts",
  "tests/task-1-agent-core.test.ts",
];

for (const path of required) {
  assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
}

console.log(
  "evals:deterministic passed (Task 0 baseline + Task 1 offline contracts and fake gateway files present; no model calls).",
);
