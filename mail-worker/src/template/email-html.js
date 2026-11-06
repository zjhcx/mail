import { parseHTML } from 'linkedom';
import domainUtils from '../utils/domain-uitls';

// The wrapper never executes scripts. The iframe has a unique opaque origin and
// cannot run scripts, submit forms, open popups, or navigate the parent page.
export const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; font-src data:; frame-src 'self' about:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";
const MAIL_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; font-src data:; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	})[character]);
}

export default function emailHtmlTemplate(html, domain) {
	const { document } = parseHTML(String(html ?? ''));
	// Defense in depth; the sandbox and CSP remain the security boundary even
	// if an HTML parser disagrees with this cleanup. Links are deliberately inert.
	document.querySelectorAll('script, meta, base, iframe, frame, frameset, object, embed, form, link').forEach(node => node.remove());
	for (const node of document.querySelectorAll('*')) {
		for (const attribute of [...node.attributes]) {
			if (/^on/i.test(attribute.name) || ['href', 'xlink:href', 'target', 'formaction', 'action', 'ping', 'download', 'srcdoc', 'referrerpolicy'].includes(attribute.name.toLowerCase())) {
				node.removeAttribute(attribute.name);
			}
		}
	}

	const attachmentBase = domainUtils.toOssDomain(domain) || '';
	const mailHtml = document.toString().replace(/{{domain}}/g, () => attachmentBase + '/');
	const srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(MAIL_CSP)}"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:12px;overflow-wrap:anywhere;font-family:Arial,sans-serif}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{cursor:default}</style></head><body>${mailHtml}</body></html>`;

	// Escape the ENTIRE document as one quoted attribute. Never embed mail in a
	// top-level script, style, or HTML element, or use top-level innerHTML.
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Email preview</title><style>html,body{margin:0;width:100%;height:100%;background:#fff}body{display:flex;flex-direction:column}p{margin:0;padding:8px 12px;font:12px Arial,sans-serif;color:#555}iframe{display:block;flex:1;width:100%;border:0}</style></head><body><p>Read-only email preview. Links and active content are disabled.</p><iframe title="Email content" sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeHtml(srcdoc)}"></iframe></body></html>`;
}
