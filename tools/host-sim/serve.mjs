/* 创意工坊宿主模拟器：只用于本地验证模块握手与 RPC，不进入安装包。
 * 用法：node tools/host-sim/serve.mjs  → 打开 http://127.0.0.1:8781/
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..', '..');
const distDir = join(moduleDir, 'dist');
const PORT = Number(process.env.SIM_PORT || 8781);

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let path;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    path = join(here, 'index.html');
  } else if (url.pathname.startsWith('/ui/')) {
    path = join(distDir, 'ui', normalize(url.pathname.slice(4)).replace(/^([/\\])+/, ''));
  } else {
    res.writeHead(404); res.end('not found'); return;
  }
  if (!existsSync(path)) { res.writeHead(404); res.end('missing ' + path); return; }
  const ext = path.slice(path.lastIndexOf('.'));
  const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
  if (url.pathname.startsWith('/ui/')) {
    /* 与 Lumina 宿主 _RUNTIME_CSP 一致（含 img-src data: blob:，SVG 走 <img> 解码必须用到） */
    headers['content-security-policy'] =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  }
  res.writeHead(200, headers);
  res.end(readFileSync(path));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[host-sim] http://127.0.0.1:${PORT}/  (dist: ${distDir})`);
});
