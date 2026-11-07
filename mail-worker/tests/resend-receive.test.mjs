import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Keep the production API -> service -> receiving path intact. Only external
// services are mocked, and D1 statements execute in SQLite rather than a SQL regex mock.
const sources = Object.fromEntries(await Promise.all([
  ['api', '../src/api/resend-api.js'],
  ['service', '../src/service/resend-service.js'],
  ['receive', '../src/service/resend-receive-service.js']
].map(async ([name, path]) => [name, await readFile(new URL(path, import.meta.url), 'utf8')])));
const rawMail = 'From: Sender <sender@remote.test>\r\nTo: spoofed@outside.test\r\nCc: hidden@example.test\r\nSubject: hello\r\n\r\n你好\r\n';
const downloadUrl = 'https://storage.resend.test/raw/message.eml';
const event = (to = ['alice@example.test'], id = 'received-1') => ({
  type: 'email.received', data: { email_id: id, from: 'sender@remote.test', to }
});
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const calls = { verify: [], api: [], fetch: [], stored: [], updates: [], sql: [] };
  const state = {
    domains: ['@Example.Test'],
    getResult: { data: { raw: { download_url: downloadUrl } }, error: null },
    fetchResponse: () => new Response(rawMail),
    deliver: async message => { await message.onStored?.(); }
  };
  const db = {
    prepare(sql) {
      calls.sql.push(sql);
      let bindings = [];
      const statement = {
        bind(...values) { bindings = values; return statement; },
        async run() { const result = sqlite.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
        async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }
      };
      return statement;
    }
  };
  const c = {
    env: { db, RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: 'whsec_test' },
    executionCtx: { waitUntil() {} },
    text: (text, status) => new Response(text, { status })
  };
  let handler;
  class Resend {
    constructor(key) {
      this.webhooks = { verify(options) {
        calls.verify.push({ key, ...options });
        if (!options.headers.id || !options.headers.timestamp || options.headers.signature !== 'valid-signature') {
          throw new Error('Invalid signature');
        }
        return JSON.parse(options.payload);
      } };
      this.emails = { receiving: { get: async id => {
        calls.api.push({ key, id });
        return typeof state.getResult === 'function' ? state.getResult(id) : state.getResult;
      } } };
    }
  }
  const context = vm.createContext({
    Response, Headers, URL, Date, Set, AbortSignal, crypto: webcrypto,
    console: { info() {}, warn() {}, error() {} },
    fetch: async (url, options) => {
      calls.fetch.push({ url: String(url), options });
      return state.fetchResponse(url, options);
    }
  });
  const mocks = {
    resend: { Resend },
    '../hono/hono': { default: { post(path, fn) { assert.equal(path, '/webhooks'); handler = fn; } } },
    '../email/email': { email: async (message, env, ctx) => {
      const raw = await new Response(message.raw).text();
      calls.stored.push({ message, raw, env, ctx });
      return state.deliver(message);
    } },
    './setting-service': { default: { query: async () => ({ domainList: state.domains }) } },
    './email-service': { default: { updateEmailStatus: async (_c, params) => { calls.updates.push(plain(params)); return { emailId: 1 }; } } },
    '../const/entity-const': { emailConst: { status: Object.fromEntries(
      ['SENT', 'DELIVERED', 'COMPLAINED', 'BOUNCED', 'DELAYED', 'FAILED'].map(status => [status, status])
    ) } }
  };
  const realImports = {
    '../service/resend-service': 'service', './resend-receive-service': 'receive'
  };
  const modules = new Map();
  function moduleFor(name) {
    if (modules.has(name)) return modules.get(name);
    let module;
    if (Object.hasOwn(sources, name)) {
      module = new vm.SourceTextModule(sources[name], { context, identifier: name });
    } else {
      const values = mocks[name];
      assert.ok(values, `Unexpected mock import: ${name}`);
      module = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context, identifier: name });
    }
    modules.set(name, module);
    return module;
  }
  const api = moduleFor('api');
  await api.link(specifier => moduleFor(realImports[specifier] ?? specifier));
  await api.evaluate();
  return {
    c, calls, state, sqlite,
    service: moduleFor('service').namespace.default,
    receive: moduleFor('receive').namespace.default,
    async request(body = event(), headers = { 'svix-id': 'evt-1', 'svix-timestamp': '123', 'svix-signature': 'valid-signature' }) {
      c.req = { text: async () => typeof body === 'string' ? body : JSON.stringify(body), header: name => headers[name] };
      return handler(c);
    },
    rows() {
      if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'resend_inbound_delivery'").get()) return [];
      return sqlite.prepare('SELECT * FROM resend_inbound_delivery ORDER BY recipient').all().map(row => ({ ...row }));
    }
  };
}

test('receiving fails closed without webhook secret, even with a valid-looking signature', async t => {
  const f = await fixture(t);
  delete f.c.env.RESEND_WEBHOOK_SECRET;
  assert.equal((await f.request()).status, 503);
  assert.equal(f.calls.api.length, 0);
  assert.equal(f.calls.stored.length, 0);
  assert.equal(f.calls.updates.length, 0);
  await assert.rejects(() => f.receive.receive(f.c, event()), /RESEND_WEBHOOK_SECRET/);
});

test('missing or invalid signature headers never dispatch the event', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { 'svix-id': 'id', 'svix-timestamp': '123', 'svix-signature': 'bad' },
    { 'svix-timestamp': '123', 'svix-signature': 'valid-signature' },
    { 'svix-id': 'id', 'svix-signature': 'valid-signature' }]) {
    assert.equal((await f.request(event(), headers)).status, 401);
  }
  assert.equal(f.calls.stored.length, 0);
  assert.equal(f.calls.api.length, 0);
  assert.deepEqual(f.rows(), []);
});

test('verified received events reach inbound pipeline, not outbound status updates', async t => {
  const f = await fixture(t);
  const body = event();
  assert.equal((await f.request(body)).status, 200);
  assert.deepEqual(plain(f.calls.verify[0]), {
    key: 're_test', payload: JSON.stringify(body), webhookSecret: 'whsec_test',
    headers: { id: 'evt-1', timestamp: '123', signature: 'valid-signature' }
  });
  assert.deepEqual(f.calls.api, [{ key: 're_test', id: 'received-1' }]);
  assert.equal(f.calls.fetch[0].url, downloadUrl);
  assert.equal(f.calls.fetch[0].options.redirect, 'error');
  assert.ok(f.calls.fetch[0].options.signal instanceof AbortSignal);
  assert.equal(f.calls.stored[0].raw, rawMail);
  assert.equal(f.calls.stored[0].message.from, 'sender@remote.test');
  assert.equal(f.calls.stored[0].message.to, 'alice@example.test');
  assert.equal(f.calls.stored[0].message.forward, undefined);
  assert.equal(f.calls.stored[0].env, f.c.env);
  assert.equal(f.calls.stored[0].ctx, f.c.executionCtx);
  assert.deepEqual(f.calls.updates, []);
  assert.equal(f.rows()[0].state, 'done');
});

test('unknown events are acknowledged without changing outbound status or receiving mail', async t => {
  const f = await fixture(t);
  for (const body of [{ type: 'future.event' }, { type: 'email.opened', data: { email_id: 'id' } }]) {
    assert.equal((await f.request(body)).status, 200);
  }
  assert.deepEqual(f.calls.updates, []);
  assert.equal(f.calls.stored.length, 0);
});

test('verified outbound status callbacks retain their existing status mappings', async t => {
  const f = await fixture(t);
  for (const [type, status, extra, message] of [
    ['email.delivered', 'DELIVERED', {}, null],
    ['email.complained', 'COMPLAINED', {}, null],
    ['email.bounced', 'BOUNCED', { bounce: { message: 'no mailbox' } }, '{"message":"no mailbox"}'],
    ['email.delivery_delayed', 'DELAYED', {}, null],
    ['email.failed', 'FAILED', { failed: { reason: 'blocked' } }, 'blocked']
  ]) {
    assert.equal((await f.request({ type, data: { email_id: 'out-1', ...extra } })).status, 200);
    assert.deepEqual(f.calls.updates.at(-1), { resendEmailId: 'out-1', status, message });
  }
  assert.equal(f.calls.verify.length, 5);
  assert.equal(f.calls.stored.length, 0);
});

test('malformed payloads return client errors and never download mail', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('not JSON')).status, 401);
  for (const body of [null, {}, { type: 123 }]) assert.equal((await f.request(body)).status, 400);
  delete f.c.env.RESEND_WEBHOOK_SECRET;
  assert.equal((await f.request('not JSON')).status, 503);
  assert.equal(f.calls.api.length, 0);
});

test('only configured envelope domains are routed; recipients are normalized and deduplicated', async t => {
  const f = await fixture(t);
  const body = event([' Alice@EXAMPLE.TEST ', 'alice@example.test', 'bob+tag@example.test',
    'outside@elsewhere.test', 'bad@@example.test', 'Display <d@example.test>', null, 3]);
  body.data.cc = ['cc@example.test'];
  body.data.raw = { download_url: 'https://attacker.test/raw' };
  assert.equal((await f.request(body)).status, 200);
  assert.deepEqual(f.calls.stored.map(call => call.message.to), ['alice@example.test', 'bob+tag@example.test']);
  assert.ok(f.calls.stored.every(call => call.raw === rawMail));
  assert.equal(f.calls.api.length, 1);
  assert.equal(f.calls.fetch.length, 1);
  assert.deepEqual(f.rows().map(row => row.state), ['done', 'done']);
});

test('events with no matching recipient are ignored without claims or API calls', async t => {
  const f = await fixture(t);
  await f.receive.receive(f.c, event(['other@outside.test', 'broken', 'x@sub.example.test']));
  f.state.domains = [];
  await f.receive.receive(f.c, event());
  assert.deepEqual(f.rows(), []);
  assert.equal(f.calls.api.length, 0);
});

test('malformed received event and missing API key fail before download', async t => {
  const f = await fixture(t);
  for (const body of [{ type: 'email.received' }, event(undefined, ''), event('alice@example.test'), event([], 123)]) {
    await assert.rejects(() => f.receive.receive(f.c, body), /Invalid Resend received event/);
  }
  delete f.c.env.RESEND_API_KEY;
  await assert.rejects(() => f.receive.receive(f.c, event()), /RESEND_API_KEY/);
  assert.equal(f.calls.api.length, 0);
});

test('done deliveries skip both storage and raw download on duplicate webhooks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request()).status, 200);
  const token = f.rows()[0].token;
  assert.equal((await f.request()).status, 200);
  assert.equal(f.calls.stored.length, 1);
  assert.equal(f.calls.api.length, 1);
  assert.equal(f.rows()[0].token, token);
});

test('partial multi-recipient failure retries only recipients not already done', async t => {
  const f = await fixture(t);
  let fail = true;
  f.state.deliver = async message => {
    if (message.to === 'bob@example.test' && fail) { fail = false; throw new Error('storage unavailable'); }
    await message.onStored();
  };
  const body = event(['alice@example.test', 'bob@example.test']);
  assert.equal((await f.request(body)).status, 500);
  assert.deepEqual(f.rows().map(row => [row.recipient, row.state]), [['alice@example.test', 'done']]);
  assert.equal((await f.request(body)).status, 200);
  assert.deepEqual(f.calls.stored.map(call => call.message.to), ['alice@example.test', 'bob@example.test', 'bob@example.test']);
  assert.deepEqual(f.rows().map(row => row.state), ['done', 'done']);
});

test('notification failure after onStored does not permit duplicate insertion on retry', async t => {
  const f = await fixture(t);
  f.state.deliver = async message => { await message.onStored(); throw new Error('notification failed after save'); };
  await f.request(); // Either propagate notification failure or acknowledge stored mail.
  assert.equal(f.rows()[0]?.state, 'done');
  assert.equal((await f.request()).status, 200);
  assert.equal(f.calls.stored.length, 1);
  assert.equal(f.calls.api.length, 1);
});

for (const failure of ['api-error', 'api-throw', 'missing-url', 'http-url', 'download-error', 'download-throw', 'body-error']) {
  test(`${failure} releases the claim and succeeds on retry`, async t => {
    const f = await fixture(t);
    if (failure === 'api-error') f.state.getResult = { error: { message: 'rate limited' }, data: null };
    if (failure === 'api-throw') f.state.getResult = () => { throw new Error('API network error'); };
    if (failure === 'missing-url') f.state.getResult = { data: { raw: {} } };
    if (failure === 'http-url') f.state.getResult = { data: { raw: { download_url: 'http://unsafe.test/raw' } } };
    if (failure === 'download-error') f.state.fetchResponse = () => new Response('unavailable', { status: 503 });
    if (failure === 'download-throw') f.state.fetchResponse = () => { throw new Error('download network error'); };
    if (failure === 'body-error') f.state.fetchResponse = () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('truncated body')); }
    }));
    assert.equal((await f.request()).status, 500);
    assert.deepEqual(f.rows(), []);
    assert.equal(f.calls.stored.length, 0);
    if (failure === 'http-url') assert.equal(f.calls.fetch.length, 0);
    f.state.getResult = { data: { raw: { download_url: downloadUrl } } };
    f.state.fetchResponse = () => new Response(rawMail);
    assert.equal((await f.request()).status, 200);
    assert.equal(f.calls.stored.length, 1);
    assert.equal(f.rows()[0].state, 'done');
  });
}

for (const mode of ['content-length', 'stream']) {
  test(`40 MiB raw size limit rejects oversized ${mode} and releases claim`, async t => {
    const f = await fixture(t);
    let cancelled = false;
    f.state.fetchResponse = () => mode === 'content-length'
      ? new Response('tiny actual body', { headers: { 'content-length': String(40 * 1024 * 1024 + 1) } })
      : new Response(new ReadableStream({
        start(controller) {
          // Reuse a 1 MiB chunk to exercise the streaming cap without a giant fixture.
          const chunk = new Uint8Array(1024 * 1024);
          for (let i = 0; i < 41; i++) controller.enqueue(chunk);
        },
        cancel() { cancelled = true; }
      }));
    assert.equal((await f.request()).status, 500);
    assert.deepEqual(f.rows(), []);
    assert.equal(f.calls.stored.length, 0);
    if (mode === 'stream') assert.equal(cancelled, true);
    f.state.fetchResponse = () => new Response(rawMail);
    assert.equal((await f.request()).status, 200);
    assert.equal(f.calls.stored.length, 1);
  });
}

test('in-flight duplicate claims fail retryably; expired leases can be reclaimed', async t => {
  const f = await fixture(t);
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  f.state.deliver = async message => { started(); await hold; await message.onStored(); };
  const first = f.receive.receive(f.c, event());
  await entered;
  const firstToken = f.rows()[0].token;
  try {
    await assert.rejects(() => f.receive.receive(f.c, event()), /already processing/);
    assert.equal(f.calls.stored.length, 1);
    assert.equal(f.rows()[0].token, firstToken);
  } finally { release(); await first; }
  f.sqlite.prepare("UPDATE resend_inbound_delivery SET state = 'processing', lease_until = 0").run();
  f.state.deliver = async message => message.onStored();
  await f.receive.receive(f.c, event());
  assert.notEqual(f.rows()[0].token, firstToken);
  assert.equal(f.rows()[0].state, 'done');
  assert.equal(f.calls.stored.length, 2);
});

test('policy rejection is terminal rather than repeatedly downloading rejected mail', async t => {
  const f = await fixture(t);
  f.state.deliver = async message => { message.setReject('Recipient not found'); };
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.calls.stored.length, 1);
  assert.equal(f.rows()[0].state, 'done');
});
