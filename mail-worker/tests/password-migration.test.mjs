import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../src/', import.meta.url);
async function load(file, mocks) {
  const context = vm.createContext({ console, Date });
  const module = new vm.SourceTextModule(await readFile(new URL(file, root), 'utf8'), { context });
  await module.link(async name => {
    const values = mocks[name] || { default: {} };
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
  });
  await module.evaluate();
  return module.namespace.default;
}
async function fixture({ valid = true, upgrade = true, cas = true } = {}) {
  const userRow = { userId: 1, email: 'one@example.test', salt: 'old-salt', password: 'old-hash', isDel: 0, status: 0 };
  const calls = { verify: 0, migrate: 0, put: 0 };
  const replacement = { salt: 'new-salt', hash: 'new-hash' };
  const users = { selectByEmailIncludeDel: async () => userRow, updateUserInfo: async () => {}, upgradePasswordHash: async (_c, row, value) => {
    calls.migrate++; assert.equal(row, userRow); assert.equal(value, replacement); return cas;
  } };
  class BizError extends Error {}
  const crypto = { verifyPasswordAndRehash: async () => { calls.verify++; return { verified: valid, replacement: valid && upgrade ? replacement : null }; } };
  const service = await load('service/login-service.js', {
    '../service/user-service': { default: users }, './user-service': { default: users },
    '../error/biz-error': { default: BizError }, '../utils/crypto-utils': { default: crypto },
    '../const/entity-const': { isDel: { DELETE: 1 }, userConst: { status: { BAN: 1 } }, settingConst: {} },
    '../utils/jwt-utils': { default: { generateToken: async () => 'new-jwt' } },
    uuid: { v4: () => 'new-session' }, '../const/kv-const': { default: { AUTH_INFO: 'auth:' } },
    '../const/constant': { default: { TOKEN_EXPIRE: 2592000 } },
    '../utils/date-uitil': { toUtc: () => {} }, '../i18n/i18n.js': { t: value => value },
    '../utils/alias-policy': { assertPrimaryEmail() {} },
    dayjs: { default: () => ({ toISOString: () => 'now' }) }
  });
  const c = { env: { kv: { get: async () => null, put: async () => { calls.put++; } } } };
  return { service, c, calls };
}

test('correct legacy password upgrades before issuing session', async () => {
  const f = await fixture();
  assert.equal(await f.service.login(f.c, { email: 'one@example.test', password: 'correct' }), 'new-jwt');
  assert.deepEqual(f.calls, { verify: 1, migrate: 1, put: 1 });
});
test('wrong password never upgrades or issues session', async () => {
  const f = await fixture({ valid: false });
  await assert.rejects(() => f.service.login(f.c, { email: 'one@example.test', password: 'wrong' }));
  assert.deepEqual(f.calls, { verify: 1, migrate: 0, put: 0 });
});
test('concurrent password change CAS failure refuses stale login', async () => {
  const f = await fixture({ cas: false });
  await assert.rejects(() => f.service.login(f.c, { email: 'one@example.test', password: 'correct' }));
  assert.deepEqual(f.calls, { verify: 1, migrate: 1, put: 0 });
});
test('OAuth bypass never validates or migrates null password', async () => {
  const f = await fixture();
  assert.equal(await f.service.login(f.c, { email: 'one@example.test', password: null }, true), 'new-jwt');
  assert.deepEqual(f.calls, { verify: 0, migrate: 0, put: 1 });
});
test('current password format does not cause database migration', async () => {
  const f = await fixture({ upgrade: false });
  await f.service.login(f.c, { email: 'one@example.test', password: 'correct' });
  assert.deepEqual(f.calls, { verify: 1, migrate: 0, put: 1 });
});
