import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, 'dist');

test('production build contains only the deployable app and removes stale output', () => {
  assert.equal(path.dirname(output), path.resolve(root));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'stale.txt'), 'old build');
  const built = spawnSync(process.execPath, ['build.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stderr);
  assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), /js\/main\.js/);
  for (const name of fs.readdirSync(path.join(root, 'js')).filter(n => n.endsWith('.js'))) {
    assert.ok(fs.existsSync(path.join(output, 'js', name)), name);
  }
  for (const name of ['dev-server.mjs', 'README.md', 'HANDOFF.md', 'CLAUDE.md', 'package.json', 'tests', 'stale.txt']) {
    assert.equal(fs.existsSync(path.join(output, name)), false, `${name} must not be published`);
  }
  const headers = fs.readFileSync(path.join(output, '_headers'), 'utf8');
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy:/);
});
