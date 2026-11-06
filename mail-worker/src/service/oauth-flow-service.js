import { getCookie, setCookie } from 'hono/cookie';
import BizError from '../error/biz-error';

export const OAUTH_FLOW_TTL = 600;
const COOKIE = 'cloud-mail-oauth-browser';
export const OAUTH_PROVIDERS = new Set(['linuxdo', 'github', 'google']);
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const now = () => Math.floor(Date.now() / 1000);
const opaque = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const oauthFlowService = {
 assertOrigin(c) {
  if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new BizError('OAuth request origin rejected', 403);
 },
 assertRedirect(c, redirectUri) {
  if (redirectUri !== new URL(c.req.url).origin + '/login') throw new BizError('OAuth redirect URI rejected', 400);
 },
 async start(c, provider, redirectUri) {
  this.assertOrigin(c);
  this.assertRedirect(c, redirectUri);
  if (!OAUTH_PROVIDERS.has(provider)) throw new BizError('Unknown OAuth provider', 400);
  const url = new URL(c.req.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new BizError('OAuth requires HTTPS', 400);
  // Schema is created only by the explicit initialization migration. Missing tables fail closed.
  await c.env.db.prepare('DELETE FROM oauth_security_flow WHERE expires <= ?').bind(now()).run();
  const browser = random(), state = random(), verifier = random();
  await c.env.db.prepare(`INSERT INTO oauth_security_flow(id,browser,provider,redirect_uri,verifier,purpose,expires)
   VALUES(?,?,?,?,?,'login',?)`).bind(state, browser, provider, redirectUri, verifier, now() + OAUTH_FLOW_TTL).run();
  setCookie(c, COOKIE, browser, { secure: url.protocol === 'https:', httpOnly: true, sameSite: 'Lax', path: '/api/oauth', maxAge: OAUTH_FLOW_TTL });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { state, redirectUri, challenge };
 },
 async consumeLogin(c, provider, state, redirectUri) {
  this.assertOrigin(c);
  this.assertRedirect(c, redirectUri);
  if (!OAUTH_PROVIDERS.has(provider) || !opaque(state)) throw new BizError('Invalid OAuth state', 403);
  const browser = getCookie(c, COOKIE);
  if (!opaque(browser)) throw new BizError('OAuth browser session missing; restart login', 403);
  const row = await c.env.db.prepare(`UPDATE oauth_security_flow SET consumed=1
   WHERE id=? AND browser=? AND provider=? AND redirect_uri=? AND purpose='login' AND consumed=0 AND expires>? RETURNING *`)
   .bind(state, browser, provider, redirectUri, now()).first();
  if (!row) throw new BizError('OAuth state expired, used or belongs to another browser', 403);
  return row;
 },
 async binding(c, provider, identity, oauthId) {
  const browser = getCookie(c, COOKIE);
  if (!opaque(browser) || !OAUTH_PROVIDERS.has(provider) || !Number.isSafeInteger(oauthId) || oauthId < 1) throw new BizError('OAuth binding context missing', 403);
  const token = random();
  await c.env.db.prepare(`INSERT INTO oauth_security_flow(id,browser,provider,redirect_uri,purpose,identity,oauth_id,expires)
   VALUES(?,?,?,'','bind',?,?,?)`).bind(token, browser, provider, identity, oauthId, now() + OAUTH_FLOW_TTL).run();
  return token;
 },
 async consumeBinding(c, token) {
  this.assertOrigin(c);
  if (!opaque(token)) throw new BizError('Invalid OAuth binding proof', 403);
  const browser = getCookie(c, COOKIE);
  if (!opaque(browser)) throw new BizError('OAuth browser session missing', 403);
  const row = await c.env.db.prepare(`UPDATE oauth_security_flow SET consumed=1
   WHERE id=? AND browser=? AND purpose='bind' AND consumed=0 AND expires>? RETURNING *`).bind(token, browser, now()).first();
  if (!row || !OAUTH_PROVIDERS.has(row.provider)) throw new BizError('Binding proof expired or already used; restart OAuth login', 403);
  // A second proof for the same identity must not start a second registration.
  const claim = await c.env.db.prepare(`INSERT INTO oauth_binding_claim(oauth_id,flow_id)
   VALUES(?,?) ON CONFLICT(oauth_id) DO NOTHING RETURNING oauth_id`).bind(row.oauth_id, row.id).first();
  if (!claim) throw new BizError('OAuth identity binding is already in progress', 409);
  return row;
 },
 async releaseBinding(c, proof) {
  // Only the holder of the exact claim can release it, including on registration failure.
  await c.env.db.prepare('DELETE FROM oauth_binding_claim WHERE oauth_id=? AND flow_id=?').bind(proof.oauth_id, proof.id).run();
 }
};
export default oauthFlowService;
