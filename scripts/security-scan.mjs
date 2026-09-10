import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const SCAN_ROOTS = ["scripts", "tests", "docs", "packages"];
const FORBIDDEN_PACKAGE_PATTERNS = [
  /cc-switch-agent/i,
  /cc[-_ ]?switch/i,
];
const SECRET_PATTERNS = [
  { name: "anthropic api key", re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "openai api key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "bearer token", re: /Authorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "github token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".pnpm-store") {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const findings = [];

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const pattern of FORBIDDEN_PACKAGE_PATTERNS) {
  const raw = JSON.stringify(packageJson);
  if (pattern.test(raw)) {
    findings.push(`package.json matches forbidden pattern: ${pattern}`);
  }
}

const files = listFiles(root).filter((file) => {
  const rel = relative(root, file);
  return SCAN_ROOTS.some((dir) => rel.startsWith(dir)) || rel === "package.json";
});

for (const file of files) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) {
      findings.push(`${rel}: possible secret (${name})`);
    }
  }
}

if (findings.length > 0) {
  console.error("security:scan failed");
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}

console.log(`security:scan passed (${files.length} files scanned; baseline secret and dependency checks only).`);
