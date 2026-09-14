import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePackageArgs, packageDesktop, resolveNodeLicense, smokePortable } from './package-desktop.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'routebench-portable-test-'));
  const hostDist = join(root, 'host');
  mkdirSync(join(hostDist, 'vendor'), { recursive: true });
  writeFileSync(join(hostDist, 'main.js'), "import './vendor/runtime.js';");
  writeFileSync(join(hostDist, 'vendor/runtime.js'), 'export {};');
  writeFileSync(join(hostDist, 'package.json'), '{"type":"module"}');
  const exe = join(root, 'app.exe');
  const nodePath = join(root, 'node.exe');
  writeFileSync(exe, 'fixture-exe');
  writeFileSync(nodePath, 'fixture-node');
  writeFileSync(join(root, 'LICENSE'), 'Node.js is licensed for use as follows: fixture license');
  return { root, exe, nodePath, hostDist, output: join(root, 'portable'), runtime: { version: 'v24.0.0', arch: 'x64', platform: 'win32' } };
}

test('packages complete host tree, runtime, licenses and provenance', () => {
  const f = fixture();
  packageDesktop(f);
  assert.equal(readFileSync(join(f.output, 'node.exe'), 'utf8'), 'fixture-node');
  assert.equal(readFileSync(join(f.output, 'agent-routebench.exe'), 'utf8'), 'fixture-exe');
  assert.ok(existsSync(join(f.output, 'local-agent-host/dist/vendor/runtime.js')));
  assert.match(readFileSync(join(f.output, 'NODE-LICENSE'), 'utf8'), /fixture license/);
  const manifest = JSON.parse(readFileSync(join(f.output, 'runtime-provenance.json')));
  assert.equal(manifest.node.source, 'bundled-node-runtime');
  assert.equal(manifest.node.licenseSource, 'local-node-license');
  assert.equal(JSON.stringify(manifest).includes(f.root), false);
  assert.match(manifest.node.sha256, /^[a-f0-9]{64}$/);
});

test('missing license fails before producing any package', () => {
  const f = fixture();
  unlinkSync(join(f.root, 'LICENSE'));
  assert.throws(() => packageDesktop(f), /license/i);
  assert.equal(existsSync(f.output), false);
});

test('official license retrieval uses exact version and fails closed', async () => {
  const f = fixture();
  unlinkSync(join(f.root, 'LICENSE'));
  const license = await resolveNodeLicense(f.nodePath, f.runtime, async url => {
    assert.equal(url, 'https://raw.githubusercontent.com/nodejs/node/v24.0.0/LICENSE');
    return { ok: true, text: async () => 'Node.js is licensed for use as follows: fixture' };
  });
  packageDesktop({ ...f, license });
  assert.equal(JSON.parse(readFileSync(join(f.output, 'runtime-provenance.json'))).node.licenseSource, license.source);
  await assert.rejects(resolveNodeLicense(f.nodePath, f.runtime, async () => ({ ok: false, status: 404 })), /license/i);
  await assert.rejects(resolveNodeLicense(f.nodePath, f.runtime, async () => ({ ok: true, text: async () => '<html>error</html>' })), /license/i);
});

test('smoke rejects the desktop reserved port', async () => {
  await assert.rejects(smokePortable('unused', 4317), /port/i);
});

test('refuses existing output without changing it', () => {
  const f = fixture();
  mkdirSync(f.output);
  writeFileSync(join(f.output, 'keep'), 'user data');
  assert.throws(() => packageDesktop(f), /exist/i);
  assert.equal(readFileSync(join(f.output, 'keep'), 'utf8'), 'user data');
});

test('rejects incomplete host before creating output', () => {
  const f = fixture();
  f.hostDist = f.root;
  assert.throws(() => packageDesktop(f), /main.js/);
  assert.equal(existsSync(f.output), false);
});

test('root package exposes the portable packaging command', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['package:desktop'], 'node scripts/package-desktop.mjs');
});

test('accepts pnpm argument separators before packaging options', () => {
  assert.deepEqual(normalizePackageArgs(['--', '--skip-build', '--output=portable']), ['--skip-build', '--output=portable']);
});
