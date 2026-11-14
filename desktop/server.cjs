'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const ASSETS = new Set(['index.html', 'styles.css', 'app.js', 'timer-core.js', 'practice-data.js', 'backup-files.js', 'sound-engine.js',
  'manifest.json', 'favicon-32.png', 'apple-touch-icon.png', 'stopwatch-dock-icon-192.png', 'stopwatch-dock-icon-512.png']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

async function serve(root) {
  let origin;
  const server = http.createServer(async (request, response) => {
    if (request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(403); response.end(); return;
    }
    let url;
    try { url = new URL(request.url, origin); }
    catch { response.writeHead(400); response.end(); return; }
    if (url.origin !== origin) { response.writeHead(400); response.end(); return; }
    const name = url.pathname.slice(1) || 'index.html';
    if (!ASSETS.has(name)) { response.writeHead(404); response.end(); return; }
    try {
      const content = await fs.readFile(path.join(root, name));
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { serve };
