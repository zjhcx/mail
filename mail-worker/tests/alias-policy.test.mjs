import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const root = new URL('../src/', import.meta.url);
const policy = await import(new URL('utils/alias-policy.js', root));
const { resolveRecipient, assertPrimaryEmail } = policy;

test('primary identities reject plus tags, including nested and empty tags', () => {
 for (const email of ['alice+shop@example.test', 'alice+@example.test', 'alice++shop@example.test', '+shop@example.test']) {
  assert.throws(() => assertPrimaryEmail(email));
 }
 assert.doesNotThrow(() => assertPrimaryEmail('alice@example.test'));
});
test('legitimate owner aliases retain their separate account, unknown tags use base', () => {
 const base = { email: 'Alice@Example.test', userId: 1, isDel: 0 };
 const alias = { email: 'alice+shop@example.test', userId: 1, isDel: 0 };
 assert.equal(resolveRecipient('ALICE+SHOP@EXAMPLE.TEST', [alias, base]), alias);
 assert.equal(resolveRecipient('alice+unknown@example.test', [alias, base]), base);
});
test('legacy cross-user alias never overrides base ownership', () => {
 const base = { email: 'alice@example.test', userId: 1, isDel: 0 };
 const attacker = { email: 'alice+shop@example.test', userId: 2, isDel: 0 };
 assert.equal(resolveRecipient(attacker.email, [attacker, base]), base);
 assert.equal(resolveRecipient(attacker.email, [attacker]), undefined);
 assert.equal(resolveRecipient(attacker.email, [attacker, { ...base, isDel: 1 }]), undefined);
});
test('deleted aliases do not divert mail, ordinary exact matching is unchanged', () => {
 const base = { email: 'alice@example.test', userId: 1, isDel: 0 };
 const alias = { email: 'alice+shop@example.test', userId: 1, isDel: 1 };
 assert.equal(resolveRecipient(alias.email, [alias, base]), base);
 assert.equal(resolveRecipient(base.email, [base]), base);
});

async function load(file, mocks) {
 const context = vm.createContext({ console });
 const module = new vm.SourceTextModule(await readFile(new URL(file, root), 'utf8'), { context });
 await module.link(async name => {
  const values = mocks[name] || { default: {} };
  return new vm.SyntheticModule(Object.keys(values), function () { for (const [key,value] of Object.entries(values)) this.setExport(key,value); }, { context });
 });
 await module.evaluate();
 return module.namespace.default;
}
function registerMocks(setting, turnstile = async () => { throw new Error('captcha-required'); }) {
 return {
  '../utils/alias-policy': policy,
  '../const/entity-const': { isDel: { DELETE: 1 }, settingConst: { register: { CLOSE: 1 }, regKey: { OPEN: 0, OPTIONAL: 2, CLOSE: 1 }, registerVerify: { OPEN: 0, COUNT: 2 } }, userConst: {} },
  './setting-service': { default: { query: async () => setting } },
  '../utils/date-uitil': { toUtc() {} }, '../i18n/i18n.js': { t: value => value },
  '../error/biz-error': { default: class extends Error {} }, uuid: { v4() {} },
  '../utils/verify-utils': { default: { isEmail: () => true } },
  '../utils/email-utils': { default: { getName: email => email.split('@')[0], getDomain: email => email.split('@')[1] } },
  './account-service': { default: { selectByEmailIncludeDel: async () => undefined } },
  './role-service': { default: { selectDefaultRole: async () => ({roleId: 1}), selectById: async () => ({availDomain: ''}), hasAvailDomainPerm: () => true } },
  './turnstile-service': { default: { verify: turnstile } }
 };
}
test('public and legacy OAuth register calls reject aliases before creating users', async () => {
 const service = await load('service/login-service.js', registerMocks({ register: 0 }));
 for (const oauth of [false, true]) {
  await assert.rejects(() => service.register({env:{}}, { email: 'victim+shop@example.test', password: 'password' }, oauth), /基础邮箱/);
 }
});
test('legacy OAuth flag cannot force registration open or bypass Turnstile', async () => {
 const params = { email: 'alice@example.test', password: 'password' };
 const disabled = await load('service/login-service.js', registerMocks({ register: 1 }));
 await assert.rejects(() => disabled.register({env:{}}, params, true), /regDisabled/);
 const enabled = await load('service/login-service.js', registerMocks({ register: 0, registerVerify: 0, regKey: 1, minEmailPrefix: 1, emailPrefixFilter: [] }));
 await assert.rejects(() => enabled.register({env:{domain:['example.test']}}, params, true), /captcha-required/);
});
test('alias creation requires active base owner and applies to insert/list helpers', async () => {
 let base = { email:'alice@example.test', userId:1, isDel:0 };
 const sql = () => {};
 const service = await load('service/account-service.js', {
  '../utils/alias-policy': policy,
  'drizzle-orm': { and(){}, asc(){}, eq(){}, gt(){}, inArray(){}, count(){}, sql, ne(){}, or(){}, lt(){}, desc(){} },
  '../const/entity-const': {accountConst:{}, isDel:{DELETE:1}, settingConst:{}},
  '../error/biz-error': {default:class extends Error{}}, '../i18n/i18n':{t:v=>v},
  '../entity/orm':{ default:()=>({select:()=>({from:()=>({where:()=>({get:async()=>base})})})}) }
 });
 await service.assertAliasOwner({}, 'alice+shop@example.test', 1);
 await assert.rejects(()=>service.assertAliasOwner({}, 'alice+shop@example.test', 2));
 await assert.rejects(()=>service.insert({}, {email:'alice+shop@example.test',userId:2}));
 await assert.rejects(()=>service.insertList({}, [{email:'alice+shop@example.test',userId:2}]));
 base={...base,isDel:1};
 await assert.rejects(()=>service.assertAliasOwner({}, 'alice+shop@example.test', 1));
});
