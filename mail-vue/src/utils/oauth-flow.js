export const OAUTH_STORAGE_KEY = 'cloud-mail-oauth'
const PROVIDER_ORIGINS = {
  linuxdo: 'https://connect.linux.do',
  github: 'https://github.com',
  google: 'https://accounts.google.com',
}
const TTL = 10 * 60 * 1000
const opaque = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function rememberOAuth(storage, provider, redirectUri, response, origin, now = Date.now()) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider) || redirectUri !== origin + '/login' || !opaque(response?.state)) throw new Error('OAuth 登录响应无效')
  const target = new URL(response.authorizationUrl)
  if (target.origin !== PROVIDER_ORIGINS[provider] || target.username || target.password ||
      target.searchParams.getAll('state').length !== 1 || target.searchParams.get('state') !== response.state ||
      target.searchParams.getAll('redirect_uri').length !== 1 || target.searchParams.get('redirect_uri') !== redirectUri ||
      target.searchParams.get('code_challenge_method') !== 'S256' || !target.searchParams.get('code_challenge')) throw new Error('OAuth 授权地址无效')
  storage.setItem(OAUTH_STORAGE_KEY, JSON.stringify({provider, state: response.state, redirectUri, createdAt: now}))
  return target.href
}

export function consumeOAuthCallback(storage, search, origin, now = Date.now()) {
  const params = new URLSearchParams(search)
  if (!['code', 'state', 'error'].some(key => params.has(key))) return null
  const pendingRaw = storage.getItem(OAUTH_STORAGE_KEY)
  // Consume before parsing/validating, including malformed or provider-error callbacks.
  storage.removeItem(OAUTH_STORAGE_KEY)
  storage.removeItem('oauthProvider')
  let pending
  try { pending = JSON.parse(pendingRaw || 'null') } catch {}
  if (params.has('error') || params.getAll('code').length !== 1 || params.getAll('state').length !== 1 ||
      !params.get('code') || params.get('code').length > 4096 || !opaque(params.get('state')) ||
      !pending || !Object.hasOwn(PROVIDER_ORIGINS, pending.provider) || pending.state !== params.get('state') ||
      pending.redirectUri !== origin + '/login' || !Number.isSafeInteger(pending.createdAt) ||
      now < pending.createdAt || now - pending.createdAt >= TTL) throw new Error('OAuth 登录状态无效或已过期，请重新点击登录')
  return {provider: pending.provider, code: params.get('code'), state: pending.state, redirectUri: pending.redirectUri}
}

export function registrationNeedsVerification(settings) {
  return settings.registerVerify === 0 || (settings.registerVerify === 2 && !!settings.regVerifyOpen)
}
