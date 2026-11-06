import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailHtmlTemplate, { escapeHtml } from '../template/email-html';
import domainUtils from "../utils/domain-uitls";

export const TELEGRAM_PREVIEW_PURPOSE = 'telegram-email-preview';
export const TELEGRAM_PREVIEW_TTL = 24 * 60 * 60;

// Deliberately reject legacy unscoped/non-expiring tokens. Old Telegram View
// buttons stop working after this upgrade; newly delivered messages get scoped,
// 24-hour links. No fallback to authentication JWTs or permanent legacy links.
export function isPreviewToken(payload, now = Math.floor(Date.now() / 1000)) {
	return !!payload
		&& payload.purpose === TELEGRAM_PREVIEW_PURPOSE
		&& Number.isSafeInteger(payload.emailId) && payload.emailId > 0
		&& Number.isSafeInteger(payload.iat) && payload.iat <= now
		&& Number.isSafeInteger(payload.exp) && payload.exp > now
		&& payload.exp > payload.iat
		&& payload.exp - payload.iat <= TELEGRAM_PREVIEW_TTL;
}

const telegramService = {

	async getEmailContent(c, params) {

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!isPreviewToken(result)) {
			c.status?.(403);
			return emailHtmlTemplate('<p>Access denied. Preview links expire after 24 hours; legacy links are no longer accepted.</p>');
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const { r2Domain } = await settingService.query(c);
				return emailHtmlTemplate(emailRow.content || '', r2Domain)
			} else {
				return emailHtmlTemplate(`<pre>${escapeHtml(emailRow.text || '')}</pre>`);
			}

		} else {
			c.status?.(404);
			return emailHtmlTemplate('<p>The email does not exist</p>');
		}

	},

	async sendEmailToBot(c, email) {

		const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

		const tgChatIds = tgChatId.split(',');

		const jwtToken = await jwtUtils.generateToken(c, {
			emailId: email.emailId,
			purpose: TELEGRAM_PREVIEW_PURPOSE
		}, TELEGRAM_PREVIEW_TTL);

		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'
		const inlineKeyboard = [
			[
				{
					text: 'View',
					web_app: { url: webAppUrl }
				}
			]
		];

		if (email.code) {
			inlineKeyboard.push([
				{
					text: email.code,
					copy_text: { text: email.code }
				}
			]);
		}

		await Promise.all(tgChatIds.map(async chatId => {
			try {
				const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						chat_id: chatId,
						parse_mode: 'HTML',
						text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
						reply_markup: {
							inline_keyboard: inlineKeyboard
						}
					})
				});
				if (!res.ok) {
					console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
				}
			} catch (e) {
				console.error(`转发 Telegram 失败:`, e.message);
			}
		}));

	}

}

export default telegramService
