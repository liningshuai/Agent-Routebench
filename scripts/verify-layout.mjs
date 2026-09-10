import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

for (const path of ["package.json", "pnpm-workspace.yaml", "LICENSE", "README.md"]) {
  assert.equal(existsSync(new URL(path, root)), true, `${path} must exist`);
}

const packageJson = JSON.parse(readFileSync(new URL("package.json", root)));
assert.equal(packageJson.name, "agent-workbench-app");
assert.equal(packageJson.private, true);
assert.equal(JSON.stringify(packageJson).includes("cc-switch-agent"), false);
