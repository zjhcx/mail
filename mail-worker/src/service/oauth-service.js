import BizError from "../error/biz-error";
import orm from "../entity/orm";
import {oauth} from "../entity/oauth";
import { and, eq, inArray } from 'drizzle-orm';
import userService from "./user-service";
import loginService from "./login-service";
import cryptoUtils from "../utils/crypto-utils";
import settingService from "./setting-service";
import {t} from '../i18n/i18n';
import flowService, { OAUTH_PROVIDERS } from './oauth-flow-service';

export function providerIdentity(platform, value) {
	if (!OAUTH_PROVIDERS.has(platform)) throw new BizError('Invalid OAuth provider', 403);
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 1) throw new BizError('Invalid OAuth identity', 403);
		value = String(value);
	}
	if (typeof value !== 'string' || !/^[1-9][0-9]{0,254}$/.test(value)) throw new BizError('Invalid OAuth identity', 403);
	return value;
}

const oauthService = {

	async start(c, provider, redirectUri) {
		if (!OAUTH_PROVIDERS.has(provider)) throw new BizError('Unknown OAuth provider', 400);
		const setting = await settingService.query(c);
		this.assertEnabled(setting, provider + 'Switch');
		if (typeof setting[provider + 'ClientId'] !== 'string' || !setting[provider + 'ClientId']) throw new BizError('OAuth client is not configured', 400);
		const flow = await flowService.start(c, provider, redirectUri);
		const endpoints = {linuxdo: 'https://connect.linux.do/oauth2/authorize', github: 'https://github.com/login/oauth/authorize', google: 'https://accounts.google.com/o/oauth2/v2/auth'};
		const url = new URL(endpoints[provider]);
		const params = {client_id: setting[provider + 'ClientId'], redirect_uri: flow.redirectUri, response_type: 'code', scope: provider === 'github' ? 'user:email' : 'openid profile email', state: flow.state, code_challenge: flow.challenge, code_challenge_method: 'S256'};
		for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
		return {authorizationUrl: url.href, state: flow.state};
	},

	async bindUser(c, params) {
		const proof = await flowService.consumeBinding(c, params.bindToken);
		let registrationStarted = false;
		try {
			const setting = await settingService.query(c);
			this.assertEnabled(setting, proof.provider + 'Switch');
			const oauthRow = await this.getById(c, proof.identity, proof.provider);
			if (!oauthRow || oauthRow.oauthId !== proof.oauth_id || oauthRow.userId !== 0) throw new BizError('OAuth identity already bound or missing', 403);
			// Reject existing targets before marking registration ambiguous. A typo naming
			// an existing user must not permanently lock this OAuth identity's claim.
			if (await userService.selectByEmailIncludeDel(c, params.email)) {
				throw new BizError('Email already exists; choose a new mailbox', 409);
			}
			// Standard registration enforces disabled registration, CAPTCHA and invitations.
			registrationStarted = true;
			await loginService.register(c, {email: params.email, password: cryptoUtils.genRandomPwd(24), code: params.code, token: params.token});
			const userRow = await userService.selectByEmail(c, params.email);
			if (!userRow) throw new BizError('OAuth registration incomplete; contact administrator', 409);
			const bound = await orm(c).update(oauth).set({userId: userRow.userId}).where(and(eq(oauth.oauthId, oauthRow.oauthId), eq(oauth.platform, proof.provider), eq(oauth.oauthUserId, proof.identity), eq(oauth.userId, 0))).returning().get();
			if (!bound) throw new BizError('OAuth identity binding conflict; contact administrator', 409);
			await flowService.releaseBinding(c, proof);
			const token = await loginService.login(c, {email: userRow.email, password: null}, true);
			return {userInfo: bound, token};
		} catch (error) {
			// Before registration there can be no partially-created account. During or
			// after registration retain the claim on ambiguous failure: fail closed,
			// never let another flow bind an account the first request may have created.
			if (!registrationStarted || !await userService.selectByEmail(c, params.email)) await flowService.releaseBinding(c, proof);
			throw error;
		}
	},

	async linuxDoLogin(c, params) {

		const { code } = params;
		if (typeof code !== 'string' || !code || code.length > 4096) throw new BizError('Invalid OAuth code', 400);
		const flow = await flowService.consumeLogin(c, 'linuxdo', params.state, params.redirectUri);
		const redirectUri = flow.redirect_uri;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'linuxdoSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.linuxdoClientId)
		reqParams.append('client_secret', setting.linuxdoClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')
		reqParams.append('code_verifier', flow.verifier)

		const tokenRes = await fetch("https://connect.linux.do/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		})

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText)
		}

		const token = await tokenRes.json();
		if (typeof token.access_token !== 'string' || !token.access_token || token.error) throw new BizError('OAuth token exchange failed', 403);

		const userRes = await fetch('https://connect.linux.do/api/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText)
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = providerIdentity('linuxdo', userInfo.id);
		userInfo.active = userInfo.active ? 0 : 1;
		userInfo.silenced = userInfo.silenced ? 0 : 1;
		userInfo.trustLevel = userInfo.trust_level;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'linuxdo';

		return await this.saveAndLogin(c, userInfo)
	},

	async githubLogin(c, params) {

		const { code } = params;
		if (typeof code !== 'string' || !code || code.length > 4096) throw new BizError('Invalid OAuth code', 400);
		const flow = await flowService.consumeLogin(c, 'github', params.state, params.redirectUri);
		const redirectUri = flow.redirect_uri;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'githubSwitch');

		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json"
			},
			body: JSON.stringify({
				client_id: setting.githubClientId,
				client_secret: setting.githubClientSecret,
				code: code,
				redirect_uri: redirectUri,
				code_verifier: flow.verifier
			})
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();
		if (typeof token.access_token !== 'string' || !token.access_token || token.error) throw new BizError('OAuth token exchange failed', 403);

		if (token.error) {
			throw new BizError(token.error_description || token.error);
		}

		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token,
				'User-Agent': 'cloud-mail'
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = providerIdentity('github', userInfo.id);
		userInfo.username = userInfo.login;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'github';

		return await this.saveAndLogin(c, userInfo);
	},

	async googleLogin(c, params) {

		const { code } = params;
		if (typeof code !== 'string' || !code || code.length > 4096) throw new BizError('Invalid OAuth code', 400);
		const flow = await flowService.consumeLogin(c, 'google', params.state, params.redirectUri);
		const redirectUri = flow.redirect_uri;

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'googleSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.googleClientId)
		reqParams.append('client_secret', setting.googleClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')
		reqParams.append('code_verifier', flow.verifier)

		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();
		if (typeof token.access_token !== 'string' || !token.access_token || token.error) throw new BizError('OAuth token exchange failed', 403);

		const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = providerIdentity('google', userInfo.sub);
		userInfo.username = userInfo.email;
		userInfo.name = userInfo.name;
		userInfo.avatar = userInfo.picture;
		userInfo.platform = 'google';

		return await this.saveAndLogin(c, userInfo);
	},

	async saveAndLogin(c, userInfo) {

		const oauthRow = await this.saveUser(c, userInfo);
		const userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (!userRow) {
			return { userInfo: oauthRow, token: null, bindToken: await flowService.binding(c, oauthRow.platform, oauthRow.oauthUserId, oauthRow.oauthId) };
		}

		const JwtToken = await loginService.login(c, { email: userRow.email, password: null }, true);
		return { userInfo: oauthRow, token: JwtToken };
	},

	async saveUser(c, userInfo) {

		userInfo.oauthUserId = providerIdentity(userInfo.platform, userInfo.oauthUserId);
		// Never spread provider-controlled fields into local identifiers/bindings.
		userInfo = {oauthUserId: userInfo.oauthUserId, platform: userInfo.platform, username: userInfo.username, name: userInfo.name, avatar: userInfo.avatar, active: userInfo.active, trustLevel: userInfo.trustLevel, silenced: userInfo.silenced};
		const userInfoRow = await this.getById(c, userInfo.oauthUserId, userInfo.platform);

		if (!userInfoRow) {
			return await orm(c).insert(oauth).values(userInfo).returning().get();
		} else {
			return await orm(c).update(oauth).set(userInfo).where(and(eq(oauth.oauthUserId, userInfo.oauthUserId), eq(oauth.platform, userInfo.platform))).returning().get();
		}

	},

	assertEnabled(setting, switchKey) {
		if (setting[switchKey] !== 0) {
			throw new BizError(t('oauthDisabled'));
		}
	},

	async getById(c, oauthUserId, platform) {
		providerIdentity(platform, oauthUserId);
		const rows = await orm(c).select().from(oauth).where(and(eq(oauth.oauthUserId, oauthUserId), eq(oauth.platform, platform))).all();
		if (rows.length > 1) throw new BizError('Ambiguous historical OAuth identity; administrator review required', 409);
		return rows[0];
	},

	async deleteByUserId(c, userId) {
		await this.deleteByUserIds(c, [userId]);
	},

	async deleteByUserIds(c, userIds) {
		await orm(c).delete(oauth).where(inArray(oauth.userId, userIds)).run();
	},

	//定时任务凌晨清除未绑定邮箱的oauth用户
	async clearNoBindOathUser(c) {
		// Do not delete an identity while its browser is choosing a mailbox or
		// registration holds a claim. Otherwise cleanup can strand a newly created
		// random-password account before the final binding CAS.
		await c.env.db.prepare(`DELETE FROM oauth WHERE user_id = 0
			AND NOT EXISTS (SELECT 1 FROM oauth_binding_claim claim WHERE claim.oauth_id = oauth.oauth_id)
			AND NOT EXISTS (SELECT 1 FROM oauth_security_flow flow WHERE flow.oauth_id = oauth.oauth_id
				AND flow.purpose = 'bind' AND flow.consumed = 0 AND flow.expires > ?)`)
			.bind(Math.floor(Date.now() / 1000)).run();
	},

}

export default  oauthService
