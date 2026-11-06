import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/service/attachment-access-service.js', import.meta.url), 'utf8');
const key = 'attachments/' + 'a'.repeat(32) + '.png';
const otherKey = 'attachments/' + 'b'.repeat(32) + '.html';
async function fixture() {
  let grant;
  let session = { userId: 1, token: 'session-1' };
  let auth = { user: { userId: 1, email: 'one@example.test' }, tokens: ['session-1'] };
  let rows = [{ key, userId: 1 }, { key: otherKey, userId: 2 }];
  let permissions = [];
  let reads = 0;
  const now = Math.floor(Date.now() / 1000);
  const mocks = {
    '../entity/orm': { default: () => ({ select: () => ({ from: () => ({ where: condition => ({ all: async () => rows.filter(row => condition(row)) }) }) }) }) },
    '../entity/att': { att: { key: 'key', userId: 'userId' } },
    'drizzle-orm': { eq: (field, value) => row => row[field] === value, inArray: (field, values) => row => values.includes(row[field]), and: (...conditions) => row => conditions.every(c => c(row)) },
    '../utils/jwt-utils': { default: { verifyToken: async (_c, token) => token === 'login' ? session : token === 'signed' ? grant : null,
      generateToken: async (_c, payload, ttl) => { grant = { ...payload, exp: now + ttl }; return 'signed'; } } },
    './perm-service': { default: { userPermKeys: async () => permissions } },
    '../const/kv-const': { default: { AUTH_INFO: 'auth:' } },
    './r2-service': { default: { toObjResp: async () => { reads++; return new Response('private data', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=999999' } }); } } }
  };
  const context = vm.createContext({ Response, Headers, Set, Date });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async specifier => {
    const values = mocks[specifier];
    const stub = new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
    return stub;
  });
  await module.evaluate();
  const c = { env: { admin: 'admin@example.test', kv: { get: async () => auth } }, get: () => auth?.user, req: { header: () => 'login' } };
  return { service: module.namespace.default, c, setGrant: value => grant = value, setAuth: value => auth = value,
    setPermissions: value => permissions = value, setRows: value => rows = value, get reads() { return reads; }, now };
}

test('URL issuance is owner-scoped, expiring, and not a login JWT URL', async () => {
  const f = await fixture();
  const result = await f.service.urls(f.c, [key, otherKey]);
  assert.equal(result.expiresIn, 300);
  assert.equal(result.urls[key], '/' + key + '?token=signed');
  assert.equal(result.urls[otherKey], undefined);
});
test('anonymous, login-token, expired, wrong-purpose and wrong-key requests never read storage', async () => {
  const f = await fixture();
  for (const token of [null, 'login']) assert.equal((await f.service.response(f.c, key, token)).status, 404);
  for (const overrides of [{ exp: f.now - 1 }, { purpose: 'login' }, { key: otherKey }, { exp: undefined }, { exp: f.now + 10000 }]) {
    f.setGrant({ purpose: 'attachment', key, userId: 1, session: 'session-1', exp: f.now + 300, ...overrides });
    assert.equal((await f.service.response(f.c, key, 'signed')).status, 404);
  }
  assert.equal(f.reads, 0);
});
test('signed links recheck session and ownership and use private safe responses', async () => {
  const f = await fixture();
  await f.service.urls(f.c, [key]);
  const response = await f.service.response(f.c, key, 'signed');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment');
  assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
  f.setRows([]);
  assert.equal((await f.service.response(f.c, key, 'signed')).status, 404);
  f.setAuth(null);
  assert.equal((await f.service.response(f.c, key, 'signed')).status, 404);
});
test('privileged email readers retain attachment access, arbitrary namespaces stay private', async () => {
  const f = await fixture();
  f.setPermissions(['all-email:query']);
  assert.ok((await f.service.urls(f.c, [otherKey])).urls[otherKey]);
  assert.equal((await f.service.objectResponse(f.c, 'setting', null)).status, 404);
  assert.equal((await f.service.objectResponse(f.c, key, null)).status, 404);
  assert.equal((await f.service.objectResponse(f.c, 'static/background/test.png', null)).status, 200);
});
test('reject malformed or oversized key batches', async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.urls(f.c, ['attachments/../setting']));
  await assert.rejects(() => f.service.urls(f.c, Array(101).fill(key)));
});
