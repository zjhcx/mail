import { Resend } from 'resend';
import { email } from '../email/email';
import settingService from './setting-service';

// D1, rather than eventually-consistent KV, serializes concurrent webhook retries.
async function claim(c, id, recipient) {
	await c.env.db.prepare(`CREATE TABLE IF NOT EXISTS resend_inbound_delivery (
		id TEXT NOT NULL, recipient TEXT NOT NULL, state TEXT NOT NULL,
		lease_until INTEGER NOT NULL, token TEXT NOT NULL,
		PRIMARY KEY (id, recipient)
	)`).run();
	const token = crypto.randomUUID();
	const now = Date.now();
	const row = await c.env.db.prepare(`INSERT INTO resend_inbound_delivery
		(id, recipient, state, lease_until, token) VALUES (?, ?, 'processing', ?, ?)
		ON CONFLICT(id, recipient) DO UPDATE SET lease_until = excluded.lease_until, token = excluded.token
		WHERE state = 'processing' AND lease_until < ? RETURNING token`)
		.bind(id, recipient, now + 10 * 60 * 1000, token, now).first();
	if (row) return token;
	const existing = await c.env.db.prepare('SELECT state FROM resend_inbound_delivery WHERE id = ? AND recipient = ?')
		.bind(id, recipient).first();
	if (existing?.state === 'done') return null;
	throw new Error('Resend delivery is already processing');
}

async function readRaw(response) {
	const limit = 40 * 1024 * 1024;
	if (Number(response.headers.get('content-length')) > limit) throw new Error('Resend raw email exceeds 40 MiB');
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new Error('Resend raw email exceeds 40 MiB');
		}
		chunks.push(value);
	}
	const raw = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
	return raw.buffer;
}

const resendReceiveService = {
	async receive(c, body) {
		if (!c.env.RESEND_WEBHOOK_SECRET) throw new Error('RESEND_WEBHOOK_SECRET is required for receiving');
		const id = body.data?.email_id;
		if (typeof id !== 'string' || !id || !Array.isArray(body.data?.to)) {
			throw new Error('Invalid Resend received event');
		}
		if (!c.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for receiving');
		const { domainList = [] } = await settingService.query(c);
		const domains = new Set(domainList.map(domain => domain.replace(/^@/, '').toLowerCase()));
		// Only route envelope recipients supplied by Resend, never untrusted MIME To/Cc.
		const recipients = [...new Set(body.data.to.filter(address => typeof address === 'string')
			.map(address => address.trim().toLowerCase())
			.filter(address => /^[^\s@<>]+@[^\s@<>]+$/.test(address) && domains.has(address.split('@')[1])))];
		if (!recipients.length) return;

		let raw;
		for (const to of recipients) {
			const token = await claim(c, id, to);
			if (!token) continue;
			let stored = false;
			const complete = async () => {
				await c.env.db.prepare(`UPDATE resend_inbound_delivery SET state = 'done', lease_until = 0
					WHERE id = ? AND recipient = ? AND token = ?`).bind(id, to, token).run();
				stored = true;
			};
			try {
				if (!raw) {
					const resend = new Resend(c.env.RESEND_API_KEY);
					const { data, error } = await resend.emails.receiving.get(id);
					if (error || !data?.raw?.download_url) throw new Error('Unable to retrieve Resend raw email');
					const url = new URL(data.raw.download_url);
					if (url.protocol !== 'https:') throw new Error('Invalid Resend raw email URL');
					// URL comes from the authenticated Resend API, not the webhook payload.
					const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
					if (!response.ok) throw new Error('Unable to download Resend raw email');
					raw = await readRaw(response);
				}
				await email({
					from: typeof body.data.from === 'string' ? body.data.from : '',
					to,
					onStored: complete,
					raw: new Response(raw).body,
					// SMTP has already accepted this message; policy rejection is terminal.
					setReject(reason) { console.info('Resend inbound rejected:', reason); }
					// No Cloudflare message.forward for Resend inbound messages.
				}, c.env, c.executionCtx);
				if (!stored) await complete();
			} catch (error) {
				if (stored) {
					console.error('Resend inbound notification failed after storage:', error);
					continue;
				}
				await c.env.db.prepare(`DELETE FROM resend_inbound_delivery
					WHERE id = ? AND recipient = ? AND token = ? AND state = 'processing'`).bind(id, to, token).run();
				throw error;
			}
		}
	}
};

export default resendReceiveService;
