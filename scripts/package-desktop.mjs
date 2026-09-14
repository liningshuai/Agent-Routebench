import { execFileSync, execSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function validateLicense(license) {
  if (!license?.text?.startsWith('Node.js is licensed for use as follows:') || !license.source) {
    throw new Error('A valid Node LICENSE with provenance is required');
  }
  return license;
}

function localLicense(nodePath) {
  const path = ['LICENSE', 'LICENSE.txt'].map(name => join(dirname(nodePath), name)).find(existsSync);
  return path ? validateLicense({ text: readFileSync(path, 'utf8'), source: resolve(path) }) : undefined;
}

export async function resolveNodeLicense(nodePath, runtime, fetchLicense = fetch) {
  const local = localLicense(nodePath);
  if (local) return local;
  if (!/^v\d+\.\d+\.\d+$/.test(runtime.version)) throw new Error('Invalid Node version for license retrieval');
  const source = `https://raw.githubusercontent.com/nodejs/node/${runtime.version}/LICENSE`;
  const response = await fetchLicense(source, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`Node LICENSE download failed: ${response.status}`);
  return validateLicense({ text: await response.text(), source });
}

function writeLicense(output, license) {
  validateLicense(license);
  writeFileSync(join(output, 'NODE-LICENSE'), license.text);
  const licenseSource = typeof license.source === 'string' && /^https:\/\//.test(license.source)
    ? license.source
    : 'local-node-license';
  return { license: 'NODE-LICENSE', licenseSource, licenseSha256: sha256(join(output, 'NODE-LICENSE')) };
}

export async function smokePortable(folder, requestedPort = 0) {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || requestedPort === 4317) throw new Error('Smoke port must be 0 (automatic) or an alternate port, never 4317');
  folder = resolve(folder);
  // Refuse occupied ports before launching; only the spawned process is ever stopped.
  const reservation = createServer();
  await new Promise((accept, reject) => { reservation.once('error', reject); reservation.listen(requestedPort, '127.0.0.1', accept); });
  const port = reservation.address().port;
  await new Promise(accept => reservation.close(accept));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|node_options|node_path)$/i.test(key)));
  env.PATH = '';
  const child = spawn(join(folder, 'node.exe'), [join(folder, 'local-agent-host/dist/main.js'), '--port', String(port)], { cwd: tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure;
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('error', error => { failure = error; });
  const closed = new Promise(accept => child.once('close', accept));
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(accept => setTimeout(accept, 100));
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`Smoke host exited: ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        if (response.ok && health.ok === true && health.service === 'agent-workbench-local-api' && health.version === 1) {
          return { port, health, emptyPath: true };
        }
      } catch {
        // The child may still be starting; keep polling until the bounded deadline.
      }
    }
    throw new Error('Smoke host startup timeout');
  } finally {
    if (child.pid && child.exitCode === null) child.kill();
    await closed;
  }
}

/** pnpm forwards its argument separator to a package script on Windows. */
export function normalizePackageArgs(argv) {
  return argv.filter((argument) => argument !== "--");
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in host distribution: ${from}`);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

export function packageDesktop({ exe, nodePath, hostDist, output, runtime, root = repoRoot, license }) {
  output = resolve(output);
  if (existsSync(output)) throw new Error(`Output already exists: ${output}; choose a new folder.`);
  for (const path of [exe, nodePath, join(hostDist, 'main.js'), join(hostDist, 'package.json')]) {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing required file: ${path}`);
  }
  if (JSON.parse(readFileSync(join(hostDist, 'package.json'))).type !== 'module') {
    throw new Error('Host package.json must declare type: module');
  }
  if (runtime.platform !== 'win32' || Number(runtime.version.replace(/^v/, '').split('.')[0]) < 24) {
    throw new Error('Windows Node >=24 required');
  }
  license = validateLicense(license ?? localLicense(nodePath));
  mkdirSync(output, { recursive: true });
  copyFileSync(exe, join(output, 'agent-routebench.exe'));
  copyFileSync(nodePath, join(output, 'node.exe'));
  copyTree(hostDist, join(output, 'local-agent-host/dist'));
  const licenseProvenance = writeLicense(output, license);
  const appLicense = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map(name => join(root, name)).find(existsSync);
  if (appLicense) copyFileSync(appLicense, join(output, 'LICENSE'));
  writeFileSync(join(output, 'runtime-provenance.json'), JSON.stringify({
    node: { ...runtime, source: 'bundled-node-runtime', resolvedBy: 'corepack pnpm exec node', sha256: sha256(nodePath), ...licenseProvenance },
    desktop: { sha256: sha256(exe) },
  }, null, 2) + '\n');
  writeFileSync(join(output, 'README.txt'), 'Agent Routebench portable\r\nDouble-click agent-routebench.exe. Keep node.exe and local-agent-host beside it.\r\nRequires Microsoft Edge WebView2 Runtime. No system Node or PowerShell required.\r\nConfiguration is stored in the Windows application configuration directory.\r\nSee runtime-provenance.json for the bundled Node version, source and checksum.\r\n');
  return output;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Package on Windows using the native Windows toolchain.');
  const args = normalizePackageArgs(process.argv.slice(2));
  if (args.some(arg => arg !== '--skip-build' && !['--output=', '--license-only=', '--smoke=', '--port='].some(prefix => arg.startsWith(prefix)))) throw new Error('Unknown portable packaging option');
  const licenseOnly = args.find(arg => arg.startsWith('--license-only='))?.slice(15);
  const smoke = args.find(arg => arg.startsWith('--smoke='))?.slice(8);
  if (licenseOnly || smoke) {
    if (licenseOnly && smoke || args.some(arg => arg === '--skip-build' || arg.startsWith('--output='))) throw new Error('Standalone license/smoke options cannot be combined with packaging');
    if (smoke) { console.log(await smokePortable(smoke, Number(args.find(arg => arg.startsWith('--port='))?.slice(7) ?? 0))); return; }
    const folder = resolve(licenseOnly);
    const nodePath = join(folder, 'node.exe');
    const manifestPath = join(folder, 'runtime-provenance.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    if (version !== manifest.node.version || sha256(nodePath) !== manifest.node.sha256) throw new Error('Bundled Node does not match provenance');
    const license = await resolveNodeLicense(nodePath, { version });
    Object.assign(manifest.node, writeLicense(folder, license));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log({ folder, version, source: license.source, licenseSha256: manifest.node.licenseSha256 });
    return;
  }
  if (args.some(arg => arg.startsWith('--port='))) throw new Error('--port requires --smoke');
  const runtime = JSON.parse(execSync('corepack pnpm exec node -p "JSON.stringify({nodePath:process.execPath,version:process.version,arch:process.arch,platform:process.platform})"', { cwd: repoRoot, encoding: 'utf8' }).trim());
  const output = resolve(repoRoot, args.find(arg => arg.startsWith('--output='))?.slice(9) || `dist/Agent-Routebench-portable-${Date.now()}`);
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  const license = await resolveNodeLicense(runtime.nodePath, runtime);
  if (!args.includes('--skip-build')) {
    for (const script of ['build-local-agent-host.mjs', 'build-desktop.mjs']) execFileSync(runtime.nodePath, [join(repoRoot, 'scripts', script)], { cwd: repoRoot, stdio: 'inherit' });
    execSync('corepack pnpm exec tauri build --no-bundle', { cwd: join(repoRoot, 'apps/desktop'), stdio: 'inherit' });
  }
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version=1'], { cwd: join(repoRoot, 'apps/desktop/src-tauri'), encoding: 'utf8' }));
  const targetDir = metadata.target_directory;
  console.log(packageDesktop({ root: repoRoot, exe: join(targetDir, 'release/agent-routebench.exe'), nodePath: runtime.nodePath, runtime, hostDist: join(repoRoot, 'apps/local-agent-host/dist'), output, license }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
