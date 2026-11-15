// Produce a static-only artifact; server code, tests and documentation stay local.
import { cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, 'dist');
if (!output.startsWith(root + sep) || dirname(output) !== root) throw new Error('Invalid build output path');
try {
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Build output must not be a symbolic link');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const allowed = new Set(['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.json', '.geojson', '.woff', '.woff2', '.ttf']);
async function copyPublic(directory) {
  let entries;
  try { entries = await readdir(resolve(root, directory), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await copyPublic(relative);
    else if (entry.isFile() && allowed.has(extname(entry.name).toLowerCase())) {
      await mkdir(dirname(resolve(output, relative)), { recursive: true });
      await cp(resolve(root, relative), resolve(output, relative));
    }
  }
}

await cp(resolve(root, 'index.html'), resolve(output, 'index.html'));
for (const directory of ['css', 'js', 'assets', 'data']) await copyPublic(directory);
await writeFile(resolve(output, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  X-Frame-Options: DENY',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
  '',
  '/js/*',
  '  Cache-Control: no-cache',
  '',
  '/css/*',
  '  Cache-Control: no-cache',
  '',
].join('\n'));
console.log(`Built workstation static assets: ${output}`);
