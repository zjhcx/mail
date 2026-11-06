import app from '../hono/hono';
import result from "../model/result";
import oauthService from "../service/oauth-service";

app.use('/oauth/*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	c.header('Referrer-Policy', 'no-referrer');
	await next();
});

app.post('/oauth/start', async (c) => {
	const { provider, redirectUri } = await c.req.json();
	return c.json(result.ok(await oauthService.start(c, provider, redirectUri)));
});

app.post('/oauth/linuxDo/login', async (c) => {
	const loginInfo = await oauthService.linuxDoLogin(c, await c.req.json());
	return c.json(result.ok(loginInfo))
});

app.post('/oauth/github/login', async (c) => {
	const loginInfo = await oauthService.githubLogin(c, await c.req.json());
	return c.json(result.ok(loginInfo))
});

app.post('/oauth/google/login', async (c) => {
	const loginInfo = await oauthService.googleLogin(c, await c.req.json());
	return c.json(result.ok(loginInfo))
});

app.put('/oauth/bindUser', async (c) => {
	const loginInfo = await oauthService.bindUser(c, await c.req.json());
	return c.json(result.ok(loginInfo))
})
