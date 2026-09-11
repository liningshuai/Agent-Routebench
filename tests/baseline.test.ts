import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = dirname(__dirname);
describe("engineering baseline", () => {
  it("uses the independent package identity", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("agent-workbench-app");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(JSON.stringify(pkg)).not.toContain("cc-switch-agent");
  });
  it("keeps strict TypeScript settings", () => {
    const base = JSON.parse(readFileSync(join(root, "tsconfig.base.json"), "utf8"));
    expect(base.compilerOptions.strict).toBe(true);
    expect(base.compilerOptions.noEmit).toBe(true);
});
