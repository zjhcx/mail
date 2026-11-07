import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const sources = await Promise.all(['setting-service', 'r2-service', 's3-service'].map(async name =>
  [name, await readFile(new URL(`../src/service/${name}.js`, import.meta.url), 'utf8')]
));
const complete = {
  bucket: 'mail', endpoint: 'https://s3.example.test', region: 'auto',
  s3AccessKey: 'original-access-key', s3SecretKey: 'original-secret-key'
};

async function fixture(storage = complete) {
  let row = {
    bucket: '', endpoint: '', region: '', s3AccessKey: '', s3SecretKey: '', ...storage,
    siteKey: 'site-key-private', secretKey: 'secret-key-private', tgBotToken: 'telegram-token-private',
    resendTokens: { 'example.test': 'resend-token-private-value' },
    emailPrefixFilter: '', forcePathStyle: 1
  };
  let writes = 0;
  const cache = new Map();
  const c = {
    env: { domain: ['example.test'], kv: { get: async () => structuredClone(row), put: async () => {} } },
    get: key => cache.get(key), set: (key, value) => cache.set(key, value)
  };
  class BizError extends Error { constructor(message) { super(message); this.name = 'BizError'; } }
  const mocks = {
    '../const/kv-const': { default: { SETTING: 'setting' } },
    '../entity/setting': { default: {} },
    '../entity/orm': { default: () => ({
      update: () => ({ set: values => ({ returning: () => ({ get: async () => {
        writes++;
        row = { ...row, ...values };
        return row;
      } }) }) }),
      select: () => ({ from: () => ({ get: async () => structuredClone(row) }) })
    }) },
    '../const/entity-const': { verifyRecordType: { REG: 'reg', ADD: 'add' }, settingConst: { forcePathStyle: { OPEN: 1 } } },
    '../error/biz-error': { default: BizError },
    '../i18n/i18n': { t: key => key },
    './verify-record-service': { default: { selectListByIP: async () => [] } },
    '../utils/domain-uitls': { default: { toOssDomain: value => value } },
    '@aws-sdk/client-s3': {
      S3Client: class { constructor(options) { this.options = options; } },
      PutObjectCommand: class {}, DeleteObjectsCommand: class {}, GetObjectCommand: class {}
    }
  };
  const context = vm.createContext({ URL, structuredClone });
  const modules = new Map(sources.map(([name, source]) => [name, new vm.SourceTextModule(source, { context })]));
  const stubs = new Map();
  await modules.get('setting-service').link(async specifier => {
    const actual = modules.get(specifier.replace('./', ''));
    if (actual) return actual;
    if (!stubs.has(specifier)) {
      const values = mocks[specifier] || { default: {} };
      stubs.set(specifier, new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context }));
    }
    return stubs.get(specifier);
  });
  await modules.get('setting-service').evaluate();
  return {
    service: modules.get('setting-service').namespace.default,
    r2: modules.get('r2-service').namespace.default,
    s3: modules.get('s3-service').namespace.default,
    c, BizError, get row() { return row; }, get writes() { return writes; }
  };
}

test('get redacts a deep copy without poisoning query, storageType or the S3 client in the same request', async () => {
  const f = await fixture();
  const cached = await f.service.query(f.c);
  const before = structuredClone(cached);
  const result = await f.service.get(f.c);
  assert.notEqual(result, cached);
  assert.notEqual(result.resendTokens, cached.resendTokens);
  for (const key of ['siteKey', 'secretKey', 's3AccessKey', 's3SecretKey', 'tgBotToken']) {
    assert.match(result[key], /\*{6}$/);
  }
  assert.match(result.resendTokens['example.test'], /\*{6}$/);
  assert.deepEqual(structuredClone(cached), before);
  assert.equal(await f.service.query(f.c), cached);
  assert.equal(result.storageType, 'S3');
  assert.equal(await f.r2.storageType(f.c), 'S3');
  const client = await f.s3.client(f.c);
  assert.equal(client.options.credentials.accessKeyId, complete.s3AccessKey);
  assert.equal(client.options.credentials.secretAccessKey, complete.s3SecretKey);
  const publicConfig = await f.service.get(f.c, true);
  assert.equal(publicConfig.siteKey, before.siteKey);
  assert.equal(publicConfig.secretKey, result.secretKey);
  assert.deepEqual(structuredClone(cached), before);
});

test('set trims storage fields and defaults a protocol-less endpoint to HTTPS', async () => {
  const f = await fixture({});
  await f.service.set(f.c, {
    bucket: '  mail  ', endpoint: '  s3.example.test:9000/base  ', region: '  auto  ',
    s3AccessKey: '  access-key  ', s3SecretKey: '  secret-key  '
  });
  for (const [key, expected] of Object.entries({
    bucket: 'mail', endpoint: 'https://s3.example.test:9000/base', region: 'auto',
    s3AccessKey: 'access-key', s3SecretKey: 'secret-key'
  })) assert.equal(f.row[key], expected);
  assert.equal(f.writes, 1);
});

test('blank credential replacements preserve saved keys and omitted fields stay unchanged', async () => {
  const f = await fixture();
  await f.service.set(f.c, { bucket: ' new-bucket ', s3AccessKey: '  ', s3SecretKey: '\t\n' });
  assert.equal(f.row.bucket, 'new-bucket');
  assert.equal(f.row.s3AccessKey, complete.s3AccessKey);
  assert.equal(f.row.s3SecretKey, complete.s3SecretKey);
  await f.service.set(f.c, { s3AccessKey: ' replacement ' });
  assert.equal(f.row.s3AccessKey, 'replacement');
  assert.equal(f.row.s3SecretKey, complete.s3SecretKey);
});

test('explicitly clearing every core field clears stored keys and permits storage fallback', async () => {
  const f = await fixture();
  await f.service.set(f.c, { bucket: '', endpoint: '', s3AccessKey: '', s3SecretKey: '' });
  for (const key of ['bucket', 'endpoint', 's3AccessKey', 's3SecretKey']) assert.equal(f.row[key], '');
  assert.equal(await f.r2.storageType(f.c), 'KV');
  f.c.env.r2 = {};
  assert.equal(await f.r2.storageType(f.c), 'R2');
});

test('partial storage configurations fail with BizError before saving', async () => {
  for (const params of [
    { bucket: 'mail' }, { endpoint: 's3.example.test' }, { region: 'auto' },
    { ...complete, s3AccessKey: '  ' }, { ...complete, s3SecretKey: '' }
  ]) {
    const f = await fixture({});
    await assert.rejects(() => f.service.set(f.c, params), f.BizError);
    assert.equal(f.writes, 0);
  }
  const f = await fixture();
  await assert.rejects(() => f.service.set(f.c, { bucket: '' }), f.BizError);
  assert.equal(f.writes, 0);
});

test('endpoint validation rejects unsafe URLs and invalid field types with BizError', async () => {
  for (const endpoint of [
    'ftp://s3.example.test', 'javascript:alert(1)', 'https://', 'https://host:invalid',
    'https://user@host', 'https://user:pass@host', 'https://@host',
    'https://host?x=1', 'https://host?', 'https://host#part', 'https://host#',
    'https://bad host', 'https://host/space here', 'https:///host', 'https://host\\\\path'
  ]) {
    const f = await fixture();
    await assert.rejects(() => f.service.set(f.c, { endpoint }), f.BizError, endpoint);
    assert.equal(f.writes, 0, endpoint);
  }
  for (const key of ['bucket', 'endpoint', 'region', 's3AccessKey', 's3SecretKey']) {
    const f = await fixture();
    await assert.rejects(() => f.service.set(f.c, { [key]: null }), f.BizError);
    assert.equal(f.writes, 0);
  }
});

test('HTTP endpoints and optional empty region remain supported', async () => {
  const f = await fixture();
  await f.service.set(f.c, { endpoint: ' http://localhost:9000 ', region: ' ' });
  assert.equal(f.row.endpoint, 'http://localhost:9000');
  assert.equal(f.row.region, '');
  assert.equal((await f.s3.client(f.c)).options.region, 'auto');
});

test('unrelated settings updates do not validate or rewrite legacy storage configuration', async () => {
  const f = await fixture({ bucket: 'legacy-partial' });
  await f.service.set(f.c, { title: 'New title' });
  assert.equal(f.row.title, 'New title');
  assert.equal(f.row.bucket, 'legacy-partial');
  assert.equal(f.row.endpoint, '');
});
