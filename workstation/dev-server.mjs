// dev-server.mjs — zero-dependency static server for the workstation.
// Equivalent to `python -m http.server 5173`, so `npm run dev` works without
// installing anything. ES modules need HTTP (not file://), which is all this does.
//
// Usage: npm run dev            -> http://localhost:5173/#/
//        PORT=8080 npm run dev  -> custom port (auto-increments if busy)
//        API_TARGET=https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev npm run dev
//
// Backend proxy: /api, /auth and /tiles (and the /api/room WebSocket) are
// forwarded to the Earth Replay Worker (API_TARGET, default the local
// `wrangler dev` on :8787). The browser sees one origin, so there is no CORS
// setup and the Auth0 session cookie travels with every /api request — the
// same arrangement as Frontend/vite.config.js. Keep port 5173: the Worker's
// FRONTEND_URL points there, so Auth0 login returns to this page.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const START_PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || 'localhost';
const API_TARGET = new URL(process.env.API_TARGET || 'http://localhost:8787');
const API_SECURE = API_TARGET.protocol === 'https:';
const API_PORT = Number(API_TARGET.port) || (API_SECURE ? 443 : 80);
const PROXY_PREFIXES = ['/api', '/auth', '/tiles'];

function isProxied(url) {
  const path = String(url || '').split('?')[0];
  return PROXY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Forward one HTTP request to API_TARGET, streaming both bodies. */
function proxyHttp(req, res) {
  const headers = { ...req.headers, host: API_TARGET.host };
  const upstream = (API_SECURE ? httpsRequest : httpRequest)(
    {
      hostname: API_TARGET.hostname,
      port: API_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
      console.log(`${up.statusCode} ${req.method} ${req.url}  -> ${API_TARGET.origin}`);
    },
  );
  upstream.on('error', (err) => {
    console.warn(`502 ${req.method} ${req.url}  -> ${API_TARGET.origin} (${err.code || err.message})`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'network', message: `Backend unreachable at ${API_TARGET.origin}. Is it running?` }));
  });
  req.pipe(upstream);
}

/** Forward a WebSocket upgrade (replay rooms) by piping raw sockets. */
function proxyUpgrade(req, socket, head) {
  if (!isProxied(req.url)) {
    socket.destroy();
    return;
  }
  const upstream = API_SECURE
    ? tlsConnect({ host: API_TARGET.hostname, port: API_PORT, servername: API_TARGET.hostname })
    : netConnect({ host: API_TARGET.hostname, port: API_PORT });
  upstream.once(API_SECURE ? 'secureConnect' : 'connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      lines.push(`${name}: ${name.toLowerCase() === 'host' ? API_TARGET.host : req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

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
  if (isProxied(req.url)) return proxyHttp(req, res);
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

server.on('upgrade', proxyUpgrade);

// One 'listening' handler, so a port fallback prints only the port actually bound.
server.once('listening', () => {
  const { port } = server.address();
  console.log(`\n  spaceapp workstation  ->  http://${HOST}:${port}/#/\n  serving ${ROOT}\n  proxying /api /auth /tiles  ->  ${API_TARGET.origin}\n  Ctrl+C to stop\n`);
  if (port !== 5173) console.warn('  Note: not on 5173, so Auth0 login will return to the wrong port (FRONTEND_URL).\n');
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
  server.listen(port, HOST);
}

listen(START_PORT);
