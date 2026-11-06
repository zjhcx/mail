import attachmentAccessService from '../service/attachment-access-service';
import result from '../model/result';
import app from '../hono/hono';

app.post('/attachment/urls', async (c) => {
	const { keys } = await c.req.json();
	c.header('Cache-Control', 'private, no-store');
	return c.json(result.ok(await attachmentAccessService.urls(c, keys)));
});

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	return attachmentAccessService.objectResponse(c, key, c.req.query('token'));
});
