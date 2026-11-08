/* 本地联调用的「假 Lumina 后端」，只实现安装脚本用到的三个路由。
 * 用法：node tools/mock-host.mjs [port]   默认 8123
 * 说明：这不是 Lumina，仅用于验证 install-to-lumina.cmd 的 4 步流程。
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8123);
const MODULE_ID = 'studio.pixelborder.pixelator';
const state = { installed: false, active: null, activated: false };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/workshop/v1/modules') {
    return send(res, 200, {
      modules: state.installed
        ? [{
          module_id: MODULE_ID, source: 'local', source_repository: 'local', official: false,
          enabled: true, active_version: state.active, previous_version: null,
          candidate_version: state.active ? null : '1.0.5', versions: ['1.0.5'],
          official_uninstalled: false, consecutive_start_failures: 0,
          runtime_url: null, icon_url: null, asset_base_url: null, version_details: []
        }]
        : []
    });
  }
  if (req.method === 'POST' && p === '/api/workshop/v1/install/local') {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      state.installed = true;
      state.active = null;
      state.activated = false;
      return send(res, 200, {
        status: 'ok',
        module: {
          module_id: MODULE_ID, source: 'local', source_repository: 'local', official: false,
          enabled: true, active_version: null, previous_version: null, candidate_version: '1.0.5',
          versions: ['1.0.5'], official_uninstalled: false, consecutive_start_failures: 0,
          runtime_url: null, icon_url: null, asset_base_url: null, version_details: []
        },
        received_bytes: size
      });
    });
    return;
  }
  if (req.method === 'POST' && p === `/api/workshop/v1/modules/${MODULE_ID}/activate`) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let version = '';
      try { version = JSON.parse(body).version || ''; } catch (e) { return send(res, 422, { detail: 'invalid json body' }); }
      if (!/^\d+\.\d+\.\d+$/.test(version)) return send(res, 422, { detail: 'invalid semver' });
      state.active = version;
      state.activated = true;
      return send(res, 200, {
        status: 'ok',
        module: {
          module_id: MODULE_ID, source: 'local', source_repository: 'local', official: false,
          enabled: true, active_version: version, previous_version: null, candidate_version: null,
          versions: ['1.0.5'], official_uninstalled: false, consecutive_start_failures: 0,
          runtime_url: null, icon_url: null, asset_base_url: null, version_details: []
        }
      });
    });
    return;
  }
  send(res, 404, { detail: 'mock: unknown route ' + req.method + ' ' + p });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-host] http://127.0.0.1:${PORT}/api/workshop/v1  (module ${MODULE_ID})`);
});
