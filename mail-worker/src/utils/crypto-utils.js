const encoder = new TextEncoder();

// Workers' historical WebCrypto PBKDF2 limit is 100,000 iterations per call.
// This is a compatibility ceiling, NOT the current OWASP recommendation (600,000
// for PBKDF2-HMAC-SHA256). Benchmark the deployed Worker/CPU budget before use;
// moving to a stronger KDF/cost later requires a new versioned format.
export const PASSWORD_ITERATIONS = 100_000;
const PREFIX = 'pbkdf2-sha256$v1$';
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value, length) {
	if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) return null;
	try {
		const bytes = Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
		return bytes.length === length && toBase64(bytes) === value ? bytes : null;
	} catch {
		return null;
	}
}

// Fixed-size comparison without an early return on the first differing byte.
// JavaScript does not provide a strict constant-time execution guarantee.
function equalBytes(a, b) {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
	return difference === 0;
}

function parseHash(hash) {
	if (typeof hash !== 'string' || hash.length > 128) return null;
	const match = /^pbkdf2-sha256\$v1\$([1-9][0-9]{0,5})\$([A-Za-z0-9+/]+={0,2})$/.exec(hash);
	if (!match) return null;
	const iterations = Number(match[1]);
	const bytes = fromBase64(match[2], HASH_BYTES);
	if (iterations > PASSWORD_ITERATIONS || !bytes) return null;
	return { iterations, bytes };
}

async function derivePassword(password, saltBytes, iterations) {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({
		name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations
	}, key, HASH_BYTES * 8);
	return new Uint8Array(bits);
}

const saltHashUtils = {
	generateSalt(length = SALT_BYTES) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return toBase64(array);
	},

	async hashPassword(password) {
		const salt = this.generateSalt();
		const hash = await this.genHashPassword(password, salt);
		return { salt, hash };
	},

	// Always creates a new-format hash. Legacy SHA-256 is verification-only.
	async genHashPassword(password, salt) {
		if (typeof password !== 'string') throw new TypeError('Password must be a string');
		const saltBytes = fromBase64(salt, SALT_BYTES);
		if (!saltBytes) throw new TypeError('Password salt must be 16 bytes of canonical base64');
		const bytes = await derivePassword(password, saltBytes, PASSWORD_ITERATIONS);
		return `${PREFIX}${PASSWORD_ITERATIONS}$${toBase64(bytes)}`;
	},

	async verifyPassword(inputPassword, salt, storedHash) {
		if (typeof inputPassword !== 'string' || typeof salt !== 'string') return false;
		if (typeof storedHash !== 'string') return false;
		if (storedHash.startsWith(PREFIX)) {
			const parsed = parseHash(storedHash);
			const saltBytes = fromBase64(salt, SALT_BYTES);
			if (!parsed || !saltBytes) return false;
			return equalBytes(await derivePassword(inputPassword, saltBytes, parsed.iterations), parsed.bytes);
		}

		// Strict legacy shape prevents malformed/unknown versioned records from
		// falling back to the old scheme. Preserve the original salt+password bytes.
		const expected = fromBase64(storedHash, HASH_BYTES);
		if (!expected || !salt.length || salt.length > 4096) return false;
		const digest = await crypto.subtle.digest('SHA-256', encoder.encode(salt + inputPassword));
		return equalBytes(new Uint8Array(digest), expected);
	},

	needsRehash(storedHash) {
		const parsed = parseHash(storedHash);
		return !parsed || parsed.iterations < PASSWORD_ITERATIONS;
	},

	// Only call on password-authenticated paths, never OAuth/password bypasses.
	// Persist replacement with a compare-and-swap on the original hash AND salt,
	// so migration cannot overwrite a concurrent password reset.
	async verifyPasswordAndRehash(inputPassword, salt, storedHash) {
		const verified = await this.verifyPassword(inputPassword, salt, storedHash);
		const replacement = verified && this.needsRehash(storedHash)
			? await this.hashPassword(inputPassword) : null;
		return { verified, replacement };
	},

	genRandomPwd(length = 8) {
		if (!Number.isSafeInteger(length) || length < 0 || length > 1024) {
			throw new RangeError('Password length must be an integer between 0 and 1024');
		}
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		// Rejection sampling avoids modulo bias and Math.random predictability.
		const bytes = new Uint8Array(32);
		while (result.length < length) {
			crypto.getRandomValues(bytes);
			for (const byte of bytes) {
				if (byte >= 248) continue;
				result += chars[byte % chars.length];
				if (result.length === length) break;
			}
		}
		return result;
	}
};

export default saltHashUtils;
