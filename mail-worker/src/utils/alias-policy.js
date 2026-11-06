// Plus addresses are aliases of a base mailbox, never independent identities.
export function hasPlusTag(email) {
	return typeof email === 'string' && email.split('@')[0].includes('+');
}

export function assertPrimaryEmail(email) {
	if (hasPlusTag(email)) {
		throw new Error('不能使用 +标签 地址注册独立用户，请先注册基础邮箱，再由其所有者添加别名。');
	}
}

export function baseEmail(email) {
	if (typeof email !== 'string') return '';
	const parts = email.split('@');
	return parts.length === 2 ? parts[0].split('+')[0] + '@' + parts[1] : '';
}

// Legacy conflicting aliases must never override the base owner's future mail.
// A deleted/missing base does not permit an orphan alias to receive mail.
export function resolveRecipient(email, accounts) {
	const normalized = String(email).toLowerCase();
	const exact = accounts.find(row => row.email.toLowerCase() === normalized);
	if (!hasPlusTag(email)) return exact;
	const base = accounts.find(row => row.email.toLowerCase() === baseEmail(email).toLowerCase());
	if (!base || base.isDel === 1) return undefined;
	return exact && exact.userId === base.userId && exact.isDel !== 1 ? exact : base;
}
