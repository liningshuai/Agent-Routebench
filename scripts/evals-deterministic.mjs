import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Task 0 ships a deterministic placeholder suite. Later tasks replace this
// with real offline eval cases; the entry point must stay executable.
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
];

for (const path of required) {
  assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
}

console.log(
  "evals:deterministic passed (Task 0 baseline only: required engineering files present; no model calls).",
);
