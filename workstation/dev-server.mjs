// dev-server.mjs — zero-dependency static server for the workstation.
// Equivalent to `python -m http.server 5173`, so `npm run dev` works without
// installing anything. ES modules need HTTP (not file://), which is all this does.
//
// Usage: npm run dev            -> http://localhost:5173/#/
//        PORT=8080 npm run dev  -> custom port (auto-increments if busy)

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const START_PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || 'localhost';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  // Resolve inside ROOT only (blocks ../ traversal).
  let file = resolve(join(ROOT, normalize(pathname)));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');

  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store', // always serve fresh files while editing
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, `Not found: ${pathname}`);
  }
  console.log(`${res.statusCode} ${req.method} ${pathname}`);
});

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < START_PORT + 20) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      listen(port + 1);
    } else {
      throw err;
    }
  });
  server.listen(port, HOST, () => {
    console.log(`\n  spaceapp workstation  ->  http://${HOST}:${port}/#/\n  serving ${ROOT}\n  Ctrl+C to stop\n`);
  });
}

listen(START_PORT);
