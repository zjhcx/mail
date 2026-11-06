// Independent, deployment-free tests:
// node --experimental-vm-modules --test mail-worker/telegram-preview.security.test.mjs
// Browser test uses local Chrome only; no project dependencies are installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = new URL('./src/', import.meta.url);
async function load(relative, mocks = {}) {
 const source = await readFile(new URL(relative, root), 'utf8');
 const context = vm.createContext({ TextEncoder, TextDecoder, crypto, btoa, atob, console, Date, Number });
 const module = new vm.SourceTextModule(source, { context });
 await module.link(async specifier => {
  const values = mocks[specifier] ?? { default: {} };
  const dependency = new vm.SyntheticModule(Object.keys(values), function () {
   for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
  return dependency;
 });
 await module.evaluate();
 return module.namespace;
}

// Intentionally do NOT sanitize in this mock: the sandbox must remain effective
// even if the cleanup/parser is bypassed. This is not a linkedom fidelity test.
const template = await load('template/email-html.js', {
 linkedom: { parseHTML: html => ({ document: { querySelectorAll: () => [], toString: () => html } }) },
 '../utils/domain-uitls': { default: { toOssDomain: value => value || null } }
});
const service = await load('service/telegram-service.js', {
 dayjs: { default: { extend() {} } },
 'drizzle-orm': { eq() {} },
 '../template/email-html': { default: template.default, escapeHtml: template.escapeHtml }
});
const jwt = await load('utils/jwt-utils.js');

function decodeAttribute(value) {
 return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

test('mail is exclusively inside escaped srcdoc with an empty sandbox', () => {
 const attack = `</iframe><script>parent.pwned=1</script><body style="</style><img src=x onerror=alert(1)>"><a target="_top" href="javascript:alert(1)">link</a>&quot;`;
 const page = template.default(attack);
 assert.match(page, /sandbox="" referrerpolicy="no-referrer"/);
 assert.doesNotMatch(page, /allow-scripts|allow-same-origin|innerHTML|<script/);
 assert.equal((page.match(/<iframe\b/g) || []).length, 1);
 const encoded = page.match(/srcdoc="([^"]*)"/)[1];
 const decoded = decodeAttribute(encoded);
 assert.ok(decoded.includes(attack));
 assert.match(decoded, /script-src &#39;none&#39;/);
 assert.match(decoded, /form-action &#39;none&#39;/);
 assert.match(template.PREVIEW_CSP, /frame-ancestors 'none'; sandbox$/);
});

test('real linkedom cleanup strips active content while retaining sandbox isolation', async () => {
 const { parseHTML } = await import('linkedom');
 const real = await load('template/email-html.js', {
  linkedom: { parseHTML },
  '../utils/domain-uitls': { default: { toOssDomain: value => value || '' } }
 });
 const page = real.default('<html><body><script>alert(1)</script><img src="https://example.test/image.png" onerror="alert(2)"><a href="javascript:alert(3)">mail</a></body></html>');
 const mail = decodeAttribute(page.match(/srcdoc="([^"]*)"/)[1]);
 assert.doesNotMatch(mail, /onerror|javascript:|<script/);
 assert.match(mail, /example\.test\/image\.png/);
 assert.match(page, /sandbox=""/);
});

test('plain text escaping prevents HTML interpretation', () => {
 assert.equal(template.escapeHtml('<img onerror="x">&\''), '&lt;img onerror=&quot;x&quot;&gt;&amp;&#39;');
});

test('only scoped, bounded, unexpired preview claims are accepted', () => {
 const now = Math.floor(Date.now() / 1000);
 const good = { emailId: 12, purpose: service.TELEGRAM_PREVIEW_PURPOSE, iat: now, exp: now + 86400 };
 assert.equal(service.isPreviewToken(good, now), true);
 for (const invalid of [null, {}, { emailId: 12 }, { ...good, purpose: 'login' }, { ...good, exp: undefined }, { ...good, exp: now }, { ...good, exp: now + 86401 }, { ...good, iat: now + 1 }, { ...good, emailId: '12' }, { ...good, emailId: 0 }]) {
  assert.equal(service.isPreviewToken(invalid, now), false);
 }
});

test('actual JWT utility signs new scoped links; legacy links fail policy', async () => {
 const c = { env: { jwt_secret: 'test-only-secret-not-used-in-production' } };
 const token = await jwt.default.generateToken(c, { emailId: 12, purpose: service.TELEGRAM_PREVIEW_PURPOSE }, service.TELEGRAM_PREVIEW_TTL);
 const payload = await jwt.default.verifyToken(c, token);
 assert.equal(service.isPreviewToken(payload), true);
 const legacy = await jwt.default.generateToken(c, { emailId: 12 });
 assert.equal(service.isPreviewToken(await jwt.default.verifyToken(c, legacy)), false);
 assert.equal(await jwt.default.verifyToken(c, token + 'tampered'), null);
});

test('service rejects legacy before DB access and isolates text/HTML/not-found output', async () => {
 const now = Math.floor(Date.now() / 1000);
 let payload = { emailId: 12 }, row, queried = 0, status;
 const module = await load('service/telegram-service.js', {
  dayjs: { default: { extend() {} } },
  'drizzle-orm': { eq() {} },
  '../utils/jwt-utils': { default: { async verifyToken() { return payload; } } },
  '../entity/orm': { default: () => { queried++; return { select: () => ({ from: () => ({ where: () => ({ get: async () => row }) }) }) }; } },
  './setting-service': { default: { async query() { return { r2Domain: '' }; } } },
  '../template/email-html': { default: template.default, escapeHtml: template.escapeHtml }
 });
 const c = { status(value) { status = value; } };
 assert.match(await module.default.getEmailContent(c, { token: 'legacy' }), /<iframe/);
 assert.equal(status, 403);
 assert.equal(queried, 0);
 payload = { emailId: 12, purpose: module.TELEGRAM_PREVIEW_PURPOSE, iat: now, exp: now + 86400 };
 row = { text: '<img src=x onerror=alert(1)>' };
 const textPage = await module.default.getEmailContent(c, { token: 'new' });
 assert.match(textPage, /&amp;lt;img/);
 row = { content: '<img src=x onerror=alert(1)>' };
 assert.doesNotMatch(await module.default.getEmailContent(c, { token: 'new' }), /<img/);
 row = null;
 assert.match(await module.default.getEmailContent(c, { token: 'new' }), /<iframe/);
 assert.equal(status, 404);
});

test('Telegram send mints purpose-bound 24-hour links', async () => {
 let signed;
 const module = await load('service/telegram-service.js', {
  dayjs: { default: { extend() {} } },
  'drizzle-orm': { eq() {} },
  './setting-service': { default: { async query() { return { tgChatId: '', customDomain: 'https://example.test' }; } } },
  '../utils/jwt-utils': { default: { async generateToken(...args) { signed = args; throw new Error('stop-before-network'); } } },
  '../template/email-html': { default: template.default, escapeHtml: template.escapeHtml }
 });
 await assert.rejects(module.default.sendEmailToBot({}, { emailId: 12 }), /stop-before-network/);
 assert.equal(signed[1].emailId, 12);
 assert.equal(signed[1].purpose, module.TELEGRAM_PREVIEW_PURPOSE);
 assert.equal(signed[2], 86400);
});

test('API applies no-store, sandbox CSP and referrer policy before generating HTML', async () => {
 let handler;
 await load('api/telegram-api.js', {
  '../hono/hono': { default: { get(route, callback) { assert.equal(route, '/telegram/getEmail/:token'); handler = callback; } } },
  '../template/email-html': { PREVIEW_CSP: template.PREVIEW_CSP },
  '../service/telegram-service': { default: { async getEmailContent() { assert.equal(headers['Cache-Control'], 'no-store, private, max-age=0'); return 'safe'; } } }
 });
 const headers = {};
 assert.equal(await handler({ header(k,v) { headers[k] = v; }, req: { param: () => ({}) }, html: value => value }), 'safe');
 assert.equal(headers['Content-Security-Policy'], template.PREVIEW_CSP);
 assert.equal(headers['Referrer-Policy'], 'no-referrer');
 assert.equal(headers['X-Frame-Options'], 'DENY');
 assert.equal(headers['X-Content-Type-Options'], 'nosniff');
 assert.equal(headers['Cloudflare-CDN-Cache-Control'], 'no-store');
});

test('headless Chrome: hostile srcdoc cannot escape, execute handlers, or navigate top', { timeout: 25000 }, async t => {
 const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
 const hits = [];
 const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/preview') {
   res.setHeader('Content-Security-Policy', template.PREVIEW_CSP);
   res.setHeader('Referrer-Policy', 'no-referrer');
   res.setHeader('Cache-Control', 'no-store');
   res.setHeader('Content-Type', 'text/html');
   const origin = `http://127.0.0.1:${server.address().port}`;
   res.end(template.default(`</iframe><script>location='${origin}/executed-script'</script><meta http-equiv="refresh" content="0;url=${origin}/navigated"><base target="_top"><img src="${origin}/missing" onerror="this.src='${origin}/executed-handler'"><a target="_top" href="javascript:location='${origin}/executed-link'">link</a><form action="${origin}/submitted"><input></form><body style="</style><img src='${origin}/missing2' onerror=this.src='${origin}/executed-style'>">Readable message`));
  } else { res.statusCode = 404; res.end('missing'); }
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const profile = await mkdtemp(path.join(tmpdir(), 'telegram-preview-test-'));
 try {
  const url = `http://127.0.0.1:${server.address().port}/preview`;
  const child = spawn(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', `--user-data-dir=${profile}`, '--virtual-time-budget=2000', '--dump-dom', url]);
  let output = '', stderr = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 18000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  assert.match(output, /<iframe[^>]*sandbox=""/);
  assert.match(output, /Read-only email preview/);
  assert.doesNotMatch(output, /<script>|<meta http-equiv="refresh"/);
  assert.ok(hits.includes('/missing'), `Expected an inert frame to render images: ${hits}`);
  assert.ok(!hits.some(url => /executed|submitted/.test(url)), `Unexpected active content: ${hits}`);
  // In this adversarial no-cleanup test meta refresh may navigate the frame
  // itself, but sandbox prevents it escaping to the top-level wrapper.
  t.diagnostic(`Browser requests: ${hits.join(', ')}`);
 } finally {
  await new Promise(resolve => server.close(resolve));
  // Verify the cleanup target is our generated disposable Chrome profile.
  assert.equal(path.dirname(profile), tmpdir());
  assert.ok(path.basename(profile).startsWith('telegram-preview-test-'));
  await rm(profile, { recursive: true, force: true });
 }
});
