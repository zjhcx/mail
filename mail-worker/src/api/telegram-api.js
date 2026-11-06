import app from '../hono/hono';
import telegramService from '../service/telegram-service';
import { PREVIEW_CSP } from '../template/email-html';

app.get('/telegram/getEmail/:token', async (c) => {
	// Set before generating the page so error responses also stay private.
	c.header('Cache-Control', 'no-store, private, max-age=0');
	c.header('CDN-Cache-Control', 'no-store');
	c.header('Cloudflare-CDN-Cache-Control', 'no-store');
	c.header('Pragma', 'no-cache');
	c.header('Referrer-Policy', 'no-referrer');
	c.header('Content-Security-Policy', PREVIEW_CSP);
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	const content = await telegramService.getEmailContent(c, c.req.param());
	return c.html(content)
});

