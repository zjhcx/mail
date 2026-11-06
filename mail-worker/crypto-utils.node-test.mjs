// Run directly: node --test mail-worker/crypto-utils.node-test.mjs
// No dependencies, Wrangler, deployment, or package.json test script involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash, pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./src/utils/crypto-utils.js', import.meta.url), 'utf8');
// The Worker source is ESM but its package does not declare type:module.
const { default: passwords, PASSWORD_ITERATIONS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const password = '正确 horse battery 🔐';
const salt = Buffer.from('0123456789abcdef').toString('base64');
const legacy = createHash('sha256').update(salt + password).digest('base64');

await test('new hashes use random 128-bit salts and versioned PBKDF2-SHA256', async () => {
	const first = await passwords.hashPassword(password);
	const second = await passwords.hashPassword(password);
	assert.equal(Buffer.from(first.salt, 'base64').length, 16);
	assert.notEqual(first.salt, second.salt);
	assert.notEqual(first.hash, second.hash);
	assert.match(first.hash, /^pbkdf2-sha256\$v1\$100000\$/);
	assert.equal(await passwords.verifyPassword(password, first.salt, first.hash), true);
	assert.equal(await passwords.verifyPassword('wrong', first.salt, first.hash), false);
	assert.equal(await passwords.verifyPassword(password, second.salt, first.hash), false);
	assert.equal(passwords.needsRehash(first.hash), false);
});

await test('PBKDF2 agrees with independent Node implementation', async () => {
	const actual = await passwords.genHashPassword(password, salt);
	const expected = pbkdf2Sync(password, Buffer.from(salt, 'base64'), PASSWORD_ITERATIONS, 32, 'sha256').toString('base64');
	assert.equal(actual, `pbkdf2-sha256$v1$${PASSWORD_ITERATIONS}$${expected}`);
});

await test('legacy SHA256 verifies without coercion and upgrades only on success', async () => {
	assert.equal(await passwords.verifyPassword(password, salt, legacy), true);
	assert.equal(await passwords.verifyPassword('wrong', salt, legacy), false);
	assert.equal(passwords.needsRehash(legacy), true);
	const failed = await passwords.verifyPasswordAndRehash('wrong', salt, legacy);
	assert.deepEqual(failed, { verified: false, replacement: null });
	const success = await passwords.verifyPasswordAndRehash(password, salt, legacy);
	assert.equal(success.verified, true);
	assert.notEqual(success.replacement.salt, salt);
	assert.equal(await passwords.verifyPassword(password, success.replacement.salt, success.replacement.hash), true);
	assert.deepEqual(await passwords.verifyPasswordAndRehash(password, success.replacement.salt, success.replacement.hash), { verified: true, replacement: null });
	assert.equal(await passwords.verifyPassword(null, salt, legacy), false);
	assert.equal(await passwords.verifyPassword(undefined, salt, legacy), false);
});

await test('lower valid stored cost is accepted and scheduled for upgrade', async () => {
	const bytes = pbkdf2Sync(password, Buffer.from(salt, 'base64'), 1000, 32, 'sha256').toString('base64');
	const hash = `pbkdf2-sha256$v1$1000$${bytes}`;
	assert.equal(await passwords.verifyPassword(password, salt, hash), true);
	assert.equal(passwords.needsRehash(hash), true);
	const result = await passwords.verifyPasswordAndRehash(password, salt, hash);
	assert.equal(result.verified, true);
	assert.match(result.replacement.hash, /\$100000\$/);
});

await test('malformed, unknown, huge-cost records fail closed before KDF', async () => {
	for (const hash of [null, '', 'bad', `pbkdf2-sha256$v2$100000$${legacy}`,
		`pbkdf2-sha256$v1$0$${legacy}`, `pbkdf2-sha256$v1$100001$${legacy}`,
		`pbkdf2-sha256$v1$99999999999$${legacy}`, `pbkdf2-sha256$v1$01000$${legacy}`,
		`pbkdf2-sha256$v1$NaN$${legacy}`, `pbkdf2-sha256$v1$100000$${legacy}$junk`,
		`pbkdf2-sha256$v1$100000$AAAA`, legacy.replace(/=$/, '')]) {
		assert.equal(await passwords.verifyPassword(password, salt, hash), false, String(hash));
	}
	const hash = await passwords.genHashPassword(password, salt);
	for (const invalidSalt of [null, '', 'AAAA', salt + ' ', '!!!!!!!!!!!!!!!!!!!!!!!!']) {
		assert.equal(await passwords.verifyPassword(password, invalidSalt, hash), false);
	}
	await assert.rejects(passwords.hashPassword(null), TypeError);
});

await test('Worker-compatible KDF calls never exceed 100000 iterations', async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	const calls = [];
	Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
		subtle: {
			importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
			digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
			deriveBits(algorithm, ...args) {
				assert.ok(algorithm.iterations <= 100000);
				calls.push(algorithm.iterations);
				return webcrypto.subtle.deriveBits(algorithm, ...args);
			}
		}
	} });
	try {
		const record = await passwords.hashPassword(password);
		assert.equal(await passwords.verifyPassword(password, record.salt, record.hash), true);
		assert.deepEqual(calls, [100000, 100000]);
	} finally {
		if (original) Object.defineProperty(globalThis, 'crypto', original);
		else delete globalThis.crypto;
	}
});

await test('generated random passwords retain the existing alphanumeric contract', () => {
	assert.match(passwords.genRandomPwd(), /^[A-Za-z0-9]{8}$/);
	assert.match(passwords.genRandomPwd(32), /^[A-Za-z0-9]{32}$/);
	assert.equal(passwords.genRandomPwd(0), '');
	for (const invalid of [-1, 1.5, NaN, Infinity, 1025]) {
		assert.throws(() => passwords.genRandomPwd(invalid), RangeError);
	}
});
