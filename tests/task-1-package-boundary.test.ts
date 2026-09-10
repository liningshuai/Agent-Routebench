import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

const CONTRACTS_PACKAGE = "@agent-workbench/agent-contracts";
const CORE_PACKAGE = "@agent-workbench/agent-core";
const GATEWAY_PACKAGE = "@agent-workbench/model-gateway";

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

function readManifest(relativePath: string): PackageManifest {
  const raw = readFileSync(join(root, relativePath), "utf8");
  return JSON.parse(raw) as PackageManifest;
}

function declaredDependencies(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

function listFiles(absoluteDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const full = join(absoluteDir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function readSourceFiles(relativeDir: string): { path: string; text: string }[] {
  return listFiles(join(root, relativeDir)).map((file) => ({
    path: relative(root, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));
}

const coreManifest = readManifest("packages/agent-core/package.json");
const gatewayManifest = readManifest("packages/model-gateway/package.json");
const contractsManifest = readManifest("packages/agent-contracts/package.json");

describe("task 1 package boundaries", () => {
  it("does not let agent-core depend on model-gateway", () => {
    expect(declaredDependencies(coreManifest)).not.toContain(GATEWAY_PACKAGE);
    expect(JSON.stringify(coreManifest)).not.toContain("model-gateway");
  });

  it("does not let model-gateway depend on agent-core", () => {
    expect(declaredDependencies(gatewayManifest)).not.toContain(CORE_PACKAGE);
    expect(JSON.stringify(gatewayManifest)).not.toContain("agent-core");
  });

  it("makes both implementation packages depend on the neutral contracts package", () => {
    expect(declaredDependencies(coreManifest)).toContain(CONTRACTS_PACKAGE);
    expect(declaredDependencies(gatewayManifest)).toContain(CONTRACTS_PACKAGE);
    expect(coreManifest.dependencies?.[CONTRACTS_PACKAGE]).toBe("workspace:*");
    expect(gatewayManifest.dependencies?.[CONTRACTS_PACKAGE]).toBe("workspace:*");
  });

  it("declares the contracts package without runtime dependencies", () => {
    expect(contractsManifest.name).toBe(CONTRACTS_PACKAGE);
    expect(contractsManifest.private).toBe(true);
    expect(declaredDependencies(contractsManifest)).toEqual([]);
  });

  it("keeps agent-core/src free of model-gateway source paths", () => {
    for (const file of readSourceFiles("packages/agent-core/src")) {
      expect(file.text, file.path).not.toContain("model-gateway");
    }
  });

  it("keeps model-gateway/src free of agent-core source paths", () => {
    for (const file of readSourceFiles("packages/model-gateway/src")) {
      expect(file.text, file.path).not.toContain("agent-core");
    }
  });

  it("has exactly one real implementation source for the shared contracts", () => {
    const allSources = readSourceFiles("packages");

    const ownersOf = (marker: string): string[] =>
      allSources.filter((file) => file.text.includes(marker)).map((file) => file.path);

    expect(ownersOf("function validateAgentMessages")).toEqual([
      "packages/agent-contracts/src/contracts.ts",
    ]);
    expect(ownersOf("function validateModelRequest")).toEqual([
      "packages/agent-contracts/src/contracts.ts",
    ]);
    expect(ownersOf("function validateAgentToolDefinitions")).toEqual([
      "packages/agent-contracts/src/contracts.ts",
    ]);
    expect(ownersOf("function isJsonValue")).toEqual([
      "packages/agent-contracts/src/contracts.ts",
    ]);
    expect(ownersOf("class AgentValidationError")).toEqual([
      "packages/agent-contracts/src/contracts.ts",
    ]);
    expect(ownersOf("interface ModelGateway")).toEqual([
      "packages/agent-contracts/src/gateway-contracts.ts",
    ]);
    expect(ownersOf("type ModelStreamEvent")).toEqual([
      "packages/agent-contracts/src/gateway-contracts.ts",
    ]);
  });

  it("keeps agent-core/src/contracts.ts as a re-export layer only", () => {
    const source = readSourceFiles("packages/agent-core/src").find(
      (file) => file.path === "packages/agent-core/src/contracts.ts",
    );

    expect(source).toBeDefined();
    expect(source?.text).toContain(CONTRACTS_PACKAGE);
    expect(source?.text).not.toContain("function ");
    expect(source?.text).not.toContain("class ");
    expect(source?.text).not.toContain("const ");
  });
});
