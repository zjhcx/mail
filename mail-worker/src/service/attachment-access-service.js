import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, eq, inArray } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import permService from './perm-service';
import KvConst from '../const/kv-const';
import r2Service from './r2-service';

export const ATTACHMENT_URL_TTL = 300;
export const isAttachmentKey = key => typeof key === 'string' && /^attachments\/[a-f0-9]{32}(?:\.[a-zA-Z0-9_-]{1,20})?$/.test(key);

const attachmentAccessService = {
	async allowedKeys(c, user, keys) {
		if (!user || !keys.length) return new Set();
		const canReadAll = user.email === c.env.admin ||
			(await permService.userPermKeys(c, user.userId)).includes('all-email:query');
		const conditions = [inArray(att.key, keys)];
		if (!canReadAll) conditions.push(eq(att.userId, user.userId));
		const rows = await orm(c).select({ key: att.key }).from(att).where(and(...conditions)).all();
		return new Set(rows.map(row => row.key));
	},

	async urls(c, keys) {
		if (!Array.isArray(keys) || keys.length > 100 || keys.some(key => !isAttachmentKey(key))) {
			throw new Error('Invalid attachment keys (maximum 100)');
		}
		keys = [...new Set(keys)];
		const user = c.get('user');
		const session = await jwtUtils.verifyToken(c, c.req.header('Authorization'));
		if (!session?.token || session.userId !== user?.userId) throw new Error('Invalid session');
		const allowed = await this.allowedKeys(c, user, keys);
		const urls = {};
		for (const key of allowed) {
			const token = await jwtUtils.generateToken(c, {
				purpose: 'attachment', key, userId: user.userId, session: session.token
			}, ATTACHMENT_URL_TTL);
			urls[key] = '/' + key + '?token=' + encodeURIComponent(token);
		}
		return { urls, expiresIn: ATTACHMENT_URL_TTL };
	},

	async response(c, key, token) {
		const deny = () => new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
		if (!isAttachmentKey(key)) return deny();
		const grant = await jwtUtils.verifyToken(c, token);
		const now = Math.floor(Date.now() / 1000);
		if (grant?.purpose !== 'attachment' || grant.key !== key || !Number.isInteger(grant.exp) ||
			grant.exp <= now || grant.exp > now + ATTACHMENT_URL_TTL || !grant.session) return deny();
		const auth = await c.env.kv.get(KvConst.AUTH_INFO + grant.userId, { type: 'json' });
		if (!auth?.tokens?.includes(grant.session) || auth.user?.userId !== grant.userId) return deny();
		if (!(await this.allowedKeys(c, auth.user, [key])).has(key)) return deny();
		const response = await r2Service.toObjResp(c, key);
		if (!response) return deny();
		const headers = new Headers(response.headers);
		headers.set('Cache-Control', 'private, no-store');
		headers.set('Referrer-Policy', 'no-referrer');
		headers.set('X-Content-Type-Options', 'nosniff');
		headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'self'");
		// Only passive raster images may render inline; HTML/SVG and other active types download.
		if (!/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(headers.get('Content-Type') || '')) {
			headers.set('Content-Disposition', 'attachment');
		}
		return new Response(response.body, { status: response.status, headers });
	},

	async objectResponse(c, key, token) {
		if (key.startsWith('attachments/')) return this.response(c, key, token);
		// Only the intentionally public website-background namespace bypasses authorization.
		if (key.startsWith('static/background/') && !key.includes('..')) {
			return await r2Service.toObjResp(c, key) || new Response('Not Found', { status: 404 });
		}
		return new Response('Not Found', { status: 404 });
	}
};
export default attachmentAccessService;
