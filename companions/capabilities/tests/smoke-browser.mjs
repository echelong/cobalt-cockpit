/** Opt-in real test. Run ONLY inside an OS/network sandbox with no external
 * egress and no secrets mounted. Requires installed Obscura render binary and
 * optional puppeteer-core; never downloads or installs dependencies. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { executeBrowser } from '../browser.mjs';

if (process.env.COBALT_BROWSER_SMOKE_ISOLATED !== '1' || !process.env.OBSCURA_BINARY)
  throw new Error('Explicit isolated smoke execution and OBSCURA_BINARY required');

let browserProcess;
const servers = [];
async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

try {
  let refusedServerRequests = 0;
  const refusedOrigin = await listen((_, response) => { refusedServerRequests++; response.end('forbidden'); });
  const origin = await listen((request, response) => {
    if (request.url === '/asset') { response.end('fixture asset'); return; }
    if (request.url === '/slow') { setTimeout(() => response.end('<p>late</p>'), 1500); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><title>Obscura fixture</title><body><p id=result>not executed</p><button id=toggle>toggle</button><input id=search>
      <script>
        document.getElementById('result').textContent='JS rendered; isolation '+(localStorage.getItem('seen')?'leaked':'fresh');
        localStorage.setItem('seen','yes');
        console.error('fixture console error');
        fetch('/asset').then(()=>console.log('asset fetched'));
        fetch(${JSON.stringify(`${refusedOrigin}/blocked`)}).catch(()=>console.log('foreign request blocked'));
        document.getElementById('toggle').onclick=()=>document.getElementById('result').textContent+='; clicked';
      </script></body></html>`);
  });
  const port = await freePort();
  browserProcess = spawn(process.env.OBSCURA_BINARY, ['serve', '--port', String(port), '--host', '127.0.0.1', '--allow-private-network'], {
    env: { PATH: '/usr/bin:/bin', OBSCURA_NAV_TIMEOUT_MS: '3000', OBSCURA_SCRIPT_DEADLINE_MS: '2000',
      OBSCURA_CDP_COMMAND_TIMEOUT_MS: '4000', OBSCURA_FETCH_TIMEOUT_MS: '2000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let runtimeLogs = '';
  browserProcess.stdout.on('data', data => { runtimeLogs = `${runtimeLogs}${data}`.slice(-4000); });
  browserProcess.stderr.on('data', data => { runtimeLogs = `${runtimeLogs}${data}`.slice(-4000); });
  browserProcess.on('error', () => {});
  const config = { browser_enabled: true, obscura_endpoint: `ws://127.0.0.1:${port}`,
    browser_allowed_origins: [origin], browser_allow_localhost: true, browser_isolation_confirmed: true,
    browser_timeout_ms: 8000, screenshot_retention: 'ephemeral' };
  let ready;
  for (let attempt = 0; attempt < 30; attempt++) {
    ready = await executeBrowser(config, { task_id: 'readiness', steps: [{ operation: 'navigate', url: origin }] });
    if (ready.status === 'observed') break;
    if (browserProcess.exitCode !== null) throw new Error('Obscura exited before readiness');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready.status, 'observed', 'real CDP readiness');
  const task = { task_id: 'real-browser-smoke', steps: [
    { operation: 'navigate', url: origin }, { operation: 'inspect' }, { operation: 'screenshot' },
    { operation: 'console' }, { operation: 'network' },
  ] };
  const observed = await executeBrowser(config, task);
  assert.equal(observed.status, 'observed');
  assert.match(observed.results[1].evidence.text, /JS rendered; isolation fresh/);
  assert.doesNotMatch(observed.results[1].evidence.text, /leaked/);
  const image = observed.results[2].evidence;
  assert.equal(image.mime_type, 'image/png'); assert.ok(image.bytes > 100);
  assert.ok(observed.results[3].evidence.messages.some(message => message.text.includes('fixture console error')));
  assert.ok(observed.results[4].evidence.requests.some(request => request.status === 200));
  assert.ok(observed.refused_request_count >= 1); assert.equal(refusedServerRequests, 0);
  const unauthorized = await executeBrowser(config, { task_id: 'unauthorized', steps: [{ operation: 'click', selector: '#toggle' }] });
  assert.equal(unauthorized.status, 'error');
  const interactiveConfig = { ...config, browser_authorized_actions: [{ task_id: 'approved', operation: 'click', selector: '#toggle' }] };
  const interacted = await executeBrowser(interactiveConfig, { task_id: 'approved', steps: [
    { operation: 'navigate', url: origin }, { operation: 'click', selector: '#toggle' }, { operation: 'snapshot' },
  ] });
  assert.equal(interacted.status, 'observed'); assert.match(interacted.results[2].evidence.text, /clicked/);
  const metadata = await executeBrowser({ ...config, browser_allowed_origins: ['http://169.254.169.254'] }, {
    task_id: 'metadata-denied', steps: [{ operation: 'navigate', url: 'http://169.254.169.254/' }],
  });
  assert.equal(metadata.status, 'error');
  const timed = await executeBrowser({ ...config, browser_timeout_ms: 100 }, { task_id: 'timeout', steps: [{ operation: 'navigate', url: `${origin}/slow` }] });
  assert.equal(timed.status, 'error'); assert.equal(timed.verification_status, 'not_verified');
  const recovery = await executeBrowser(config, { task_id: 'recovery', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(recovery.status, 'observed'); assert.match(recovery.results[1].evidence.text, /isolation fresh/);
  process.stdout.write(`${JSON.stringify({ kind: 'real_obscura_smoke', runtime: 'v0.2.4', passed: true,
    checks: ['real_js_dom', 'png_screenshot', 'console_error', 'network_observed', 'foreign_request_blocked',
      'metadata_refused', 'fresh_context_storage_isolation', 'unauthorized_action_refused', 'approved_click', 'timeout_not_verified', 'recovery'],
    screenshot_bytes: image.bytes, refused_request_count: observed.refused_request_count,
    screenshot_persisted: false, external_egress: false })}\n`);
} finally {
  if (browserProcess && browserProcess.exitCode === null) {
    browserProcess.kill('SIGTERM');
    await Promise.race([once(browserProcess, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
  }
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
