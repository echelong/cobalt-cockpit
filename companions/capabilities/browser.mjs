/** Optional Obscura companion. No browser is installed or launched here. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const TEXT_LIMIT = 4000;
const MAX_STEPS = 12;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1800000;
const OPERATIONS = new Set(['navigate', 'inspect', 'snapshot', 'console', 'network', 'screenshot', 'click', 'fill']);
const sensitive = /(?:password|passwd|secret|token|api.?key|authorization|credential|session|cookie)/i;
const redact = value => String(value ?? '').slice(0, TEXT_LIMIT)
  .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
  .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
  .replace(/((?:password|passwd|secret|token|api.?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');

function safeUrl(raw) {
  try { const url = new URL(raw); return url.origin.slice(0, 1024); }
  catch { return '[invalid URL]'; }
}

function ipv4Forbidden(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isForbiddenAddress(address) {
  if (isIP(address) === 4) return ipv4Forbidden(address);
  if (isIP(address) !== 6) return true;
  // Only ordinary global-unicast IPv6 is admitted. Translation/tunnel prefixes
  // are conservatively refused instead of trying to infer embedded endpoints.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  return !/^2[0-9a-f]{3}:/.test(normalized) || normalized.startsWith('2001:0:')
    || normalized.startsWith('2001:db8:') || normalized.startsWith('2002:');
}

const loopback = host => host === 'localhost' || host === '127.0.0.1' || host === '::1';
const hostOf = url => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

function validateConfig(config) {
  if (config.browser_isolation_confirmed !== true) throw new Error('OS and network isolation must be explicitly confirmed');
  const endpoint = new URL(config.obscura_endpoint);
  if (endpoint.protocol !== 'ws:' || !loopback(hostOf(endpoint)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Obscura endpoint must be a credential-free loopback ws URL');
  if (!Array.isArray(config.browser_allowed_origins) || !config.browser_allowed_origins.length || config.browser_allowed_origins.length > 32)
    throw new Error('An exact browser origin allowlist is required');
  const origins = new Set(config.browser_allowed_origins.map(raw => {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || raw !== url.origin || url.username || url.password)
      throw new Error('Browser allowlist entries must be exact HTTP(S) origins');
    return url.origin;
  }));
  const timeout = config.browser_timeout_ms ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('Browser timeout must be 100–30000 ms');
  if (!['none', 'ephemeral'].includes(config.screenshot_retention ?? 'none')) throw new Error('Screenshot retention must be none or ephemeral');
  return { endpoint: endpoint.href, origins, timeout };
}

async function permittedUrl(raw, config, origins, lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !origins.has(url.origin)) return false;
  if ([...url.searchParams.keys()].some(key => sensitive.test(key))) return false;
  const host = hostOf(url);
  if (loopback(host)) return config.browser_allow_localhost === true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !isIP(host)) return false;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  return addresses.length > 0 && addresses.every(item => !isForbiddenAddress(item.address));
}

function authorized(config, taskId, step) {
  return Array.isArray(config.browser_authorized_actions) && config.browser_authorized_actions.some(grant =>
    grant.task_id === taskId && grant.operation === step.operation && grant.selector === step.selector
    && (step.operation !== 'fill' || grant.value === step.value));
}

/** Returned text is untrusted evidence, never instructions or a passed gate.
 * DNS preflight supplements Obscura's connect-time SSRF guard; it cannot pin DNS.
 * Operator isolation must enforce egress, especially for local-mode services.
 */
export async function executeBrowser(config = {}, args = {}, { connect, lookup = dnsLookup } = {}) {
  config ??= {};
  args ??= {};
  if (config.browser_enabled !== true) return { status: 'disabled', executed: false, results: [] };
  const started = Date.now();
  let browser, context, expired = false, timer, outcome;
  const results = [], consoleMessages = [], network = [], blocked = [];
  const check = () => { if (expired) throw new Error('Browser task timed out'); };
  let settings;
  try {
    settings = validateConfig(config);
    if (typeof args.task_id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(args.task_id)) throw new Error('A bounded task_id is required');
    if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > MAX_STEPS) throw new Error('Browser task requires 1–12 steps');
    for (const step of args.steps) {
      if (!step || !OPERATIONS.has(step.operation)) throw new Error('Unsupported browser operation');
      if (['click', 'fill'].includes(step.operation)) {
        if (typeof step.selector !== 'string' || step.selector.length > 256 || sensitive.test(step.selector)
          || !authorized(config, args.task_id, step)) throw new Error('Browser interaction lacks an exact operator grant');
        if (step.operation === 'fill' && (typeof step.value !== 'string' || step.value.length > 1000 || sensitive.test(step.value)))
          throw new Error('Sensitive or oversized fill refused');
      }
      if (step.operation === 'screenshot' && config.screenshot_retention !== 'ephemeral') throw new Error('Screenshot requires ephemeral evidence consent');
      if (step.operation === 'navigate' && typeof step.url !== 'string') throw new Error('Navigation URL required');
    }
    const work = async () => {
      // Validate all planned navigations before contacting the browser service.
      for (const step of args.steps) if (step.operation === 'navigate' && !await permittedUrl(step.url, config, settings.origins, lookup))
        throw new Error('Navigation refused by browser policy');
      check();
      if (!connect) {
        let puppeteer;
        try { puppeteer = await import('puppeteer-core'); }
        catch { throw new Error('Optional puppeteer-core dependency unavailable'); }
        connect = puppeteer.connect;
      }
      const connected = await connect({ browserWSEndpoint: settings.endpoint, protocolTimeout: settings.timeout });
      if (expired) { connected.disconnect(); check(); }
      browser = connected;
      const created = await browser.createBrowserContext();
      if (expired) { await created.close(); check(); }
      context = created;
      const page = await context.newPage(); check();
      // New windows are not an admitted task resource. Egress isolation must
      // still prevent a racing popup from bypassing the page interception.
      page.on('popup', popup => { void popup.close().catch(() => {}); });
      page.setDefaultTimeout(settings.timeout);
      page.setDefaultNavigationTimeout(settings.timeout);
      await page.setViewport({ width: 1280, height: 720 }); check();
      page.on('console', message => { if (consoleMessages.length < 100) consoleMessages.push({ type: redact(message.type()), text: redact(message.text()) }); });
      page.on('pageerror', error => { if (consoleMessages.length < 100) consoleMessages.push({ type: 'pageerror', text: redact(error.message) }); });
      page.on('response', response => { if (network.length < 100) network.push({ url: safeUrl(response.url()), status: response.status() }); });
      page.on('request', request => {
        void (async () => {
          const headers = request.headers();
          const allowed = !expired && ['GET', 'HEAD'].includes(request.method())
            && !Object.keys(headers).some(name => ['authorization', 'proxy-authorization', 'cookie'].includes(name.toLowerCase()))
            && await permittedUrl(request.url(), config, settings.origins, lookup);
          if (!allowed || expired) {
            if (blocked.length < 100) blocked.push({ url: safeUrl(request.url()), method: request.method() });
            await request.abort('blockedbyclient');
          } else await request.continue();
        })().catch(() => { void request.abort('blockedbyclient').catch(() => {}); });
      });
      await page.setRequestInterception(true); check();
      for (const step of args.steps) {
        check();
        let evidence;
        switch (step.operation) {
          case 'navigate': await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: settings.timeout }); evidence = { url: safeUrl(page.url()) }; break;
          case 'inspect':
          case 'snapshot': {
            // Fixed code only. Never return passwords, form values, cookies,
            // storage or page-authored executable snippets to the agent.
            const observed = await page.evaluate(() => ({
              title: String(document.title).slice(0, 512),
              text: String(document.body?.innerText ?? '').slice(0, 4000),
              elements: Array.from(document.querySelectorAll('a,button,input,select,textarea')).slice(0, 50)
                .map(el => ({ tag: el.tagName, type: el.getAttribute('type') ?? '', text: String(el.innerText ?? '').slice(0, 100) }))
            }));
            evidence = { url: safeUrl(page.url()), title: redact(observed.title), text: redact(observed.text),
              elements: observed.elements.slice(0, 50).map(el => ({ tag: redact(el.tag), type: redact(el.type), text: redact(el.text) })) }; break;
          }
          case 'console': evidence = { messages: consoleMessages.slice() }; break;
          case 'network': evidence = { requests: network.slice(), refused: blocked.slice() }; break;
          case 'screenshot': {
            const image = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
            if (image.length > MAX_IMAGE_BYTES || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot missing or oversized');
            evidence = { mime_type: 'image/png', bytes: image.length, base64: image.toString('base64'), retention: 'ephemeral' }; break;
          }
          case 'click': await page.click(step.selector); evidence = { action: 'clicked' }; break;
          case 'fill':
            // Use maintained Puppeteer locator fill, not user-supplied JS.
            await page.locator(step.selector).fill(step.value); evidence = { action: 'filled' }; break;
        }
        check();
        results.push({ operation: step.operation, evidence, trust: 'untrusted_reference' });
        if (Buffer.byteLength(JSON.stringify(results)) > MAX_OUTPUT_BYTES - 2048) throw new Error('Browser evidence output limit');
      }
      return { status: 'observed', executed: true, task_id: args.task_id, verification_status: 'requires_commander_review', results,
        refused_request_count: blocked.length, duration_ms: Date.now() - started };
    };
    return outcome = await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Browser task timed out')); }, settings.timeout);
    })]);
  } catch (error) {
    // Upstream errors can embed URLs, page content and credentials. Export
    // enumerated codes only; never return raw exceptions or stack traces.
    const message = String(error?.message ?? '');
    const unavailable = message === 'Optional puppeteer-core dependency unavailable'
      || error?.code === 'ECONNREFUSED' || /ECONNREFUSED|WebSocket/i.test(message);
    const code = message === 'Browser task timed out' ? 'browser_timeout'
      : message === 'Browser evidence output limit' ? 'browser_output_limit'
      : unavailable ? 'browser_unavailable' : 'browser_policy_or_execution_error';
    return outcome = { status: unavailable ? 'unavailable' : 'error',
      executed: false, task_id: /^[A-Za-z0-9_.-]{1,80}$/.test(args.task_id ?? '') ? args.task_id : undefined,
      verification_status: 'not_verified', error: code, results: [], duration_ms: Date.now() - started };
  } finally {
    expired = true;
    clearTimeout(timer);
    if (context) {
      let cleanupTimer;
      const closed = await Promise.race([context.close().then(() => true, () => false),
        new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), 1000); })]);
      clearTimeout(cleanupTimer);
      if (outcome) outcome.cleanup_confirmed = closed;
      if (!closed && outcome) Object.assign(outcome, { status: 'error', executed: false,
        error: 'browser_cleanup_failed', verification_status: 'not_verified', results: [] });
    }
    if (browser) browser.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 24576) throw new Error('Input exceeds 24 KiB'); }
    const { config, arguments: args } = JSON.parse(input);
    process.stdout.write(`${JSON.stringify(await executeBrowser(config, args))}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ status: 'error', executed: false, error: 'browser_invalid_input', results: [] })}\n`); }
}
