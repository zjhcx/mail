import resendService from '../service/resend-service';
import app from '../hono/hono';
import { Resend } from 'resend';
app.post('/webhooks',async (c) => {
	const payload = await c.req.text();
	let body;
	if (c.env.RESEND_WEBHOOK_SECRET) {
		try {
			body = new Resend(c.env.RESEND_API_KEY || 'webhook-verification').webhooks.verify({
				payload,
				headers: {
					id: c.req.header('svix-id'),
					timestamp: c.req.header('svix-timestamp'),
					signature: c.req.header('svix-signature')
				},
				webhookSecret: c.env.RESEND_WEBHOOK_SECRET
			});
		} catch {
			return c.text('Invalid webhook signature', 401);
		}
	} else {
		return c.text('Resend webhook signing secret is not configured', 503);
	}
	if (!body || typeof body.type !== 'string') return c.text('Invalid webhook event', 400);
	try {
		await resendService.webhooks(c, body);
		return c.text('success', 200);
	} catch (e) {
		console.error('Resend webhook processing failed:', e);
		return c.text('Webhook processing failed', 500);
	}
})
