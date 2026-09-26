/*
 * serve.js — 零依赖静态文件服务器（用于 Docker web 服务与本地预览）。
 * 用法：node scripts/serve.js [目录]   端口由环境变量 PORT 指定（默认 8080）。
 * 提供 /healthz 供健康检查。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || 'dist');
const port = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  const p = path.normalize(path.join(dir, url === '/' ? 'index.html' : url));
  if (!p.startsWith(dir + path.sep) && p !== dir) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(p)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}).listen(port, '0.0.0.0', () => console.log(`serving ${dir} on :${port}`));
