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
    if (request.url === '/redirect') { response.writeHead(302, { Location: `${refusedOrigin}/blocked` }); response.end(); return; }
    const owner = /^\/page-([ab])$/.exec(request.url ?? '')?.[1];
    if (owner) {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><title>page ${owner}</title><body><p id=who>marker-${owner}</p>
        <script>console.log('console-${owner}'); document.getElementById('who').textContent += localStorage.getItem('owner') ? ' shared' : ' alone'; localStorage.setItem('owner','${owner}');</script></body></html>`);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><title>Obscura fixture</title><body><p id=result>not executed</p><button id=toggle>toggle</button><input id=search><input id=locked readonly value=locked><input id=hidden-field type=hidden value=secret-token><input id=name oninput="document.getElementById('result').textContent='named:'+this.value">
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
  let runtimeLogs = '';
  const startBrowser = () => {
    const started = spawn(process.env.OBSCURA_BINARY, ['serve', '--port', String(port), '--host', '127.0.0.1', '--allow-private-network'], {
      env: { PATH: '/usr/bin:/bin', OBSCURA_NAV_TIMEOUT_MS: '3000', OBSCURA_SCRIPT_DEADLINE_MS: '2000',
        OBSCURA_CDP_COMMAND_TIMEOUT_MS: '4000', OBSCURA_FETCH_TIMEOUT_MS: '2000' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.stdout.on('data', data => { runtimeLogs = `${runtimeLogs}${data}`.slice(-4000); });
    started.stderr.on('data', data => { runtimeLogs = `${runtimeLogs}${data}`.slice(-4000); });
    started.on('error', () => {});
    return started;
  };
  const stopBrowser = async () => {
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) { browserProcess.kill('SIGKILL'); await once(browserProcess, 'exit'); }
  };
  browserProcess = startBrowser();
  const config = { browser_enabled: true, obscura_endpoint: `ws://127.0.0.1:${port}`,
    browser_allowed_origins: [origin], browser_allow_localhost: true, browser_isolation_confirmed: true,
    browser_timeout_ms: 8000, screenshot_retention: 'ephemeral' };
  const untilReady = async () => {
    let ready;
    for (let attempt = 0; attempt < 30; attempt++) {
      ready = await executeBrowser(config, { task_id: 'readiness', steps: [{ operation: 'navigate', url: origin }] });
      if (ready.status === 'observed') break;
      if (browserProcess.exitCode !== null) throw new Error('Obscura exited before readiness');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready.status, 'observed', 'real CDP readiness');
  };
  await untilReady();
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
  const interactiveConfig = { ...config, browser_authorized_actions: [{ task_id: 'approved', origin, operation: 'click', selector: '#toggle' }] };
  const interacted = await executeBrowser(interactiveConfig, { task_id: 'approved', steps: [
    { operation: 'navigate', url: origin }, { operation: 'click', selector: '#toggle' }, { operation: 'snapshot' },
  ] });
  assert.equal(interacted.status, 'observed'); assert.match(interacted.results[2].evidence.text, /clicked/);
  // Form filling needs the same exact private grant, and must mutate the real DOM.
  const unauthorizedFill = await executeBrowser(config, { task_id: 'unauthorized-fill', steps: [
    { operation: 'navigate', url: origin }, { operation: 'fill', selector: '#name', value: 'Ada Lovelace' },
  ] });
  assert.equal(unauthorizedFill.status, 'error');
  const fillConfig = { ...config, browser_authorized_actions: [{ task_id: 'approved-fill', origin, operation: 'fill', selector: '#name', value: 'Ada Lovelace' }] };
  const mismatchedFill = await executeBrowser(fillConfig, { task_id: 'approved-fill', steps: [
    { operation: 'navigate', url: origin }, { operation: 'fill', selector: '#name', value: 'Grace Hopper' },
  ] });
  assert.equal(mismatchedFill.status, 'error');
  const filled = await executeBrowser(fillConfig, { task_id: 'approved-fill', steps: [
    { operation: 'navigate', url: origin }, { operation: 'fill', selector: '#name', value: 'Ada Lovelace' }, { operation: 'snapshot' },
  ] });
  assert.equal(filled.status, 'observed');
  assert.equal(filled.results[1].evidence.action, 'filled');
  assert.match(filled.results[2].evidence.text, /named:Ada Lovelace/);
  // Readonly and hidden fields are refused before anything is cleared or typed.
  for (const [selector, value] of [['#locked', 'overwrite'], ['#hidden-field', 'probe']]) {
    const guarded = await executeBrowser({ ...config, browser_authorized_actions: [{ task_id: 'guarded-fill', origin, operation: 'fill', selector, value }] }, {
      task_id: 'guarded-fill', steps: [{ operation: 'navigate', url: origin }, { operation: 'fill', selector, value }],
    });
    assert.equal(guarded.status, 'error', selector);
    assert.deepEqual(guarded.operations_completed, ['navigate'], selector);
    assert.equal(guarded.effects_possible, true, selector);
  }
  // A redirect off the allowlist is refused after landing. The render engine
  // issues the hop before the request policy can refuse it, so the target
  // origin does receive one request: that residual is contained by the
  // operator's OS/egress isolation, and the task is never reported observed.
  const redirected = await executeBrowser(config, { task_id: 'redirect', steps: [{ operation: 'navigate', url: `${origin}/redirect` }] });
  assert.equal(redirected.status, 'error');
  assert.equal(redirected.executed, false); assert.equal(redirected.effects_possible, true);
  const redirectHits = refusedServerRequests;
  assert.ok(redirectHits >= 1, `expected the issued hop, got ${redirectHits}`);
  const metadata = await executeBrowser({ ...config, browser_allowed_origins: ['http://169.254.169.254'] }, {
    task_id: 'metadata-denied', steps: [{ operation: 'navigate', url: 'http://169.254.169.254/' }],
  });
  assert.equal(metadata.status, 'error');
  const timed = await executeBrowser({ ...config, browser_timeout_ms: 100 }, { task_id: 'timeout', steps: [{ operation: 'navigate', url: `${origin}/slow` }] });
  assert.equal(timed.status, 'error'); assert.equal(timed.verification_status, 'not_verified');
  const recovery = await executeBrowser(config, { task_id: 'recovery', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(recovery.status, 'observed'); assert.match(recovery.results[1].evidence.text, /isolation fresh/);
  // Readiness probe against the real control endpoint: no context, no page.
  const probed = [];
  const probe = await executeBrowser(config, { task_id: 'probe', steps: [{ operation: 'status' }] }, { onStep: name => probed.push(name) });
  assert.equal(probe.status, 'ready'); assert.deepEqual(probe.operations_completed, ['status']); assert.deepEqual(probed, ['status']);
  // Step telemetry follows the order the real browser executed.
  const order = [];
  const walked = await executeBrowser(config, { task_id: 'ordered', steps: [
    { operation: 'navigate', url: origin }, { operation: 'snapshot' }, { operation: 'console' }, { operation: 'network' }, { operation: 'screenshot' },
  ] }, { onStep: name => order.push(name) });
  assert.equal(walked.status, 'observed'); assert.deepEqual(order, ['navigate', 'snapshot', 'console', 'network', 'screenshot']);
  assert.deepEqual(walked.results.map(row => row.operation), order);
  // Localhost needs its own explicit authorization on top of the allowlist entry,
  // and that authorization opens no other private range.
  const noLocalhost = await executeBrowser({ ...config, browser_allow_localhost: false }, { task_id: 'no-localhost', steps: [{ operation: 'navigate', url: origin }] });
  assert.equal(noLocalhost.status, 'error'); assert.equal(noLocalhost.effects_possible, false);
  for (const target of ['http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'http://100.64.0.1']) {
    const refused = await executeBrowser({ ...config, browser_allowed_origins: [target] }, { task_id: 'private-range', steps: [{ operation: 'navigate', url: `${target}/` }] });
    assert.equal(refused.status, 'error', target); assert.equal(refused.effects_possible, false, target);
  }
  // Bounded input is refused before the browser is contacted.
  const oversized = await executeBrowser(config, { task_id: 'oversized', steps: Array.from({ length: 13 }, () => ({ operation: 'snapshot' })) });
  assert.equal(oversized.status, 'error'); assert.equal(oversized.steps_completed, 0);
  // Two tasks running at once each get their own context, storage and evidence.
  const [taskA, taskB] = await Promise.all(['a', 'b'].map(owner => executeBrowser(config, { task_id: `owner-${owner}`, steps: [
    { operation: 'navigate', url: `${origin}/page-${owner}` }, { operation: 'snapshot' }, { operation: 'console' },
  ] })));
  for (const [result, owner, other] of [[taskA, 'a', 'b'], [taskB, 'b', 'a']]) {
    assert.equal(result.status, 'observed', owner); assert.equal(result.task_id, `owner-${owner}`);
    assert.match(result.results[1].evidence.text, new RegExp(`marker-${owner} alone`)); assert.equal(result.results[1].evidence.title, `page ${owner}`);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`marker-${other}|console-${other}|page ${other}`));
    assert.ok(result.results[2].evidence.messages.some(message => message.text.includes(`console-${owner}`)));
  }
  // Browser failure: a killed browser mid-task is never reported observed and
  // keeps the navigation's possible effect visible.
  const dying = executeBrowser(config, { task_id: 'killed-mid-task', steps: [{ operation: 'navigate', url: `${origin}/slow` }, { operation: 'snapshot' }] });
  await new Promise(resolve => setTimeout(resolve, 300));
  await stopBrowser();
  const killed = await dying;
  assert.notEqual(killed.status, 'observed'); assert.equal(killed.executed, false); assert.equal(killed.effects_possible, true);
  assert.deepEqual(killed.results, []);
  // With the browser gone both a task and the probe report unavailable.
  const gone = await executeBrowser(config, { task_id: 'browser-gone', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(gone.status, 'unavailable'); assert.equal(gone.error, 'browser_unavailable'); assert.equal(gone.executed, false);
  const goneProbe = await executeBrowser(config, { task_id: 'probe-gone', steps: [{ operation: 'status' }] });
  assert.equal(goneProbe.status, 'unavailable'); assert.equal(goneProbe.effects_possible, false);
  // Restart on the same endpoint: fresh state, nothing carried over.
  browserProcess = startBrowser();
  await untilReady();
  const restarted = await executeBrowser(config, { task_id: 'after-restart', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(restarted.status, 'observed'); assert.match(restarted.results[1].evidence.text, /isolation fresh/);
  assert.equal((await executeBrowser(config, { task_id: 'probe-restarted', steps: [{ operation: 'status' }] })).status, 'ready');
  process.stdout.write(`${JSON.stringify({ kind: 'real_obscura_smoke', runtime: 'v0.2.4', passed: true,
    checks: ['real_js_dom', 'png_screenshot', 'console_error', 'network_observed', 'foreign_request_blocked',
      'metadata_refused', 'fresh_context_storage_isolation', 'unauthorized_action_refused', 'approved_click',
      'unauthorized_fill_refused', 'fill_value_mismatch_refused', 'approved_fill_dom_mutation',
      'readonly_fill_refused', 'hidden_fill_refused', 'redirect_off_allowlist_refused_after_hop',
      'timeout_not_verified', 'recovery', 'readiness_probe', 'step_order_reported', 'localhost_requires_authorization',
      'private_ranges_refused', 'oversized_task_refused', 'concurrent_task_evidence_attribution',
      'killed_browser_not_observed', 'browser_gone_unavailable', 'restart_recovery'],
    killed_mid_task_status: killed.status, killed_mid_task_error: killed.error,
    screenshot_bytes: image.bytes, refused_request_count: observed.refused_request_count,
    page_request_refusals: observed.refused_request_count, redirect_hop_hits: redirectHits,
    screenshot_persisted: false, external_egress: false })}\n`);
} finally {
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    browserProcess.kill('SIGTERM');
    await Promise.race([once(browserProcess, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
  }
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
