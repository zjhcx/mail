import emailService from './email-service';
import { emailConst } from '../const/entity-const';
import resendReceiveService from './resend-receive-service';

const resendService = {

	async webhooks(c, body) {
		if (body.type === 'email.received') return resendReceiveService.receive(c, body);
		if (!['email.sent', 'email.delivered', 'email.complained', 'email.bounced',
			'email.delivery_delayed', 'email.failed'].includes(body.type)) return;
		if (typeof body.data?.email_id !== 'string' || !body.data.email_id) {
			throw new Error('Invalid Resend email ID');
		}

		const params = {
			resendEmailId: body.data.email_id,
			status: emailConst.status.SENT
		}

		if (body.type === 'email.delivered') {
			params.status = emailConst.status.DELIVERED
			params.message = null
		}

		if (body.type === 'email.complained') {
			params.status = emailConst.status.COMPLAINED
			params.message = null
		}

		if (body.type === 'email.bounced') {
			let bounce = body.data.bounce
			bounce = JSON.stringify(bounce);
			params.status = emailConst.status.BOUNCED
			params.message = bounce
		}

		if (body.type === 'email.delivery_delayed') {
			params.status = emailConst.status.DELAYED
			params.message = null
		}

		if (body.type === 'email.failed') {
			params.status = emailConst.status.FAILED
			params.message = body.data.failed.reason
		}

		const emailRow = await emailService.updateEmailStatus(c, params)

		if (!emailRow) {
			// 未知邮件事件（如历史数据、重复投递、测试事件）：记录日志后正常返回，
			// 避免 Resend 因连续收到 500 而熔断关闭 Webhook
			console.warn(`resend webhook: unknown email_id ${params.resendEmailId}, type ${body.type}`);
			return;
		}

	}
}

export default resendService
