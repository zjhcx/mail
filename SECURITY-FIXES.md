# 安全修复：预览、附件、密码、OAuth 与别名

首轮修复审查报告最初第 3–5 项，本轮继续修复 OAuth 平台身份混淆、未授权绑定、登录 CSRF 和 +标签 别名抢注。修复不代表整个项目已经通过安全审计。

## 1. Telegram 邮件预览

- 不可信邮件只在无任何权限的 `sandbox` iframe 内显示，顶层页面不执行邮件 HTML。
- 增加 CSP、no-referrer、nosniff、禁止嵌入和浏览器/CDN no-store。
- HTML 清理作为纵深防御，不依赖仅移除 script 标签；纯文本先转义。
- 新预览链接绑定独立 purpose，24 小时到期；旧的无限期或未限定用途链接返回 403。
- 邮件中的链接被禁用；远程图片仍允许，因此不等于阻止邮件跟踪。
- 不对 Telegram 预览签发附件下载权限；受保护的内嵌图片可能不显示，需要登录正常邮箱页面查看。

## 2. 私密附件

- `/attachments/*`、`/oss/attachments/*`、`/api/oss/attachments/*` 不再接受裸 key 下载。
- 正常登录后通过 `POST /api/attachment/urls` 获取仅用于指定对象、5 分钟有效的签名 URL。
- 签发及使用时检查附件归属；管理员及具有 `all-email:query` 的用户保留全邮件附件读取能力。
- 下载时重新检查登录会话及对象权限；注销或撤销会话后，签名 URL 随之失效（受 Cloudflare KV 最终一致性影响，撤销传播并非瞬时）。
- 登录 JWT 不放入 URL，短期能力令牌只保存在前端内存；缓存不超过 4 分钟，禁止响应公开缓存。
- HTML/SVG 等主动内容强制作为附件下载，并附加 sandbox CSP；仅被动栅格图片允许内联。
- 回复/转发读取既有图片附件时也检查所有者，不能只知道别人的 key 就作为自己的邮件附件发出。
- 静态背景命名空间 `static/background/` 保持公开；其他存储对象默认拒绝 HTTP 访问。

**部署必要操作：**

1. 关闭 R2 的公开桶/r2.dev、自定义公开域名及 S3 的公共访问；禁止 CDN/其它代理直接公开 `attachments/`。代码不能撤回独立存储/CDN的访问权限。
2. 主动清除旧附件响应及 Telegram 预览的 CDN 缓存；新的 no-store 不会追溯清理旧缓存。
3. 前端与 Worker 一起更新。旧客户端的裸附件 URL 将失效，不做不安全回退。
4. 已签发的附件链接在有效期内仍是 bearer capability，不应分享；到期后重新打开邮件/点击附件以获取新链接。
5. 若浏览器已缓存旧公开附件，服务器不能远程撤回已下载副本。

## 3. 密码哈希与迁移

- 新密码用 PBKDF2-HMAC-SHA256、100,000 次迭代、16 字节随机盐及 32 字节输出。
- 保留现有 password/salt 数据库列，不需要改表。格式为 `pbkdf2-sha256$v1$100000$<base64>`。
- 旧单次 SHA-256 仅用于兼容验证；正确的密码登录或管理员公开 API 验证后自动升级，失败不迁移，OAuth 免密码登录不触发迁移。
- 迁移采用旧密码哈希和盐的 compare-and-swap，避免覆盖同时发生的改密；并发冲突时拒绝本次登录，用户可重试。
- 默认随机密码改用 WebCrypto 安全随机源。
- 100,000 次是为兼容 Workers WebCrypto 迭代上限的折中，**不是达到 OWASP 600,000 次建议的声明**。上线前需验证实际 Worker CPU 配额、登录及批量注册的耗时；应结合边缘限流防止昂贵 KDF 被滥用。
- 未再次密码登录的旧账户不会自动升级；数据库备份中旧哈希也不会改变。需要立即消除旧哈希时应实施密码重置策略。
- 升级后不得直接回滚到仅支持旧 SHA-256 的版本，否则已迁移用户将无法登录；部署前备份数据库并制定兼容回滚方案。

## 4. OAuth 身份和授权流程

- 身份查询/更新绑定 `(platform, oauth_user_id)`；数据库增加组合唯一索引。第三方资料仅白名单字段入库，不接受其提供的本地 userId/oauthId。
- 新入口 `POST /api/oauth/start` 创建 10 分钟 state 和 PKCE S256，浏览器通过 HttpOnly、SameSite=Lax Cookie 绑定；回调必须携带匹配 state、平台、redirectUri 和浏览器 Cookie。
- state 在 D1 通过条件 UPDATE RETURNING 原子消费，不依赖最终一致性 KV 的 get/delete 做一次性校验。重放、跨浏览器、固定旧 state 和非同源请求失败。
- redirectUri 必须是当前请求 origin 的 `/login`；生产环境需要 HTTPS，反向代理需保持正确外部 URL。第三方应用中也必须登记完全相同回调地址。
- 首次第三方登录仅签发短时一次性 bindToken；绑定时必须提供凭据及同浏览器 Cookie，不再接受 oauthUserId 作为授权证明。
- 绑定注册遵守普通注册开关、人机验证和邀请码限制；不支持用此接口绑定任意已存在邮箱。
- 使用 D1 identity claim 串行化首次绑定，精确 oauthId/平台/用户 ID 条件更新；异常时不猜测绑定归属。

### OAuth 升级顺序及历史数据

1. 备份 D1，临时关闭 OAuth 入口，人工审查历史身份记录。旧版本可能曾覆写 platform，因此新代码**无法自动判断并修复已经污染的绑定**。必要时解除可疑绑定并经独立渠道核实真实用户；考虑撤销已有会话。
2. 执行数据库初始化/迁移，新增 `oauth_security_flow`、`oauth_binding_claim` 和组合唯一索引。若发现重复或无效身份会明确失败，不合并、不删除；先人工处理再重试。未迁移时新 OAuth 流程 fail closed。
3. 同时更新前后端，旧授权回调及旧绑定表单不可继续，必须重新点击第三方登录。多个标签页并行登录可能因 Cookie 被替换而失败，重新发起即可。
4. 在隔离环境实际验证每个启用提供方的 PKCE、Cookie、回调和新账户绑定；不允许为了兼容旧平台而退回固定 state 或裸 ID 绑定。
5. 注册后发生中断可能保留 `oauth_binding_claim`，此时停止绑定并要求管理员核查。必须先确认未创建用户/绑定未完成，才能清除对应 claim；不要批量自动解锁或把孤立账户交给后续任意请求。
6. 审查用只读 SQL 位于 `mail-worker/tests/alias-audit.sql`，包含重复 OAuth 身份检查。迁移/初始化本身仍沿用原项目管理入口，请勿公开初始化密钥或把它写入日志。

## 5. +标签 别名归属

- 普通注册、OAuth 注册、管理员创建用户和公开批量创建用户均禁止以 `+标签` 地址创建独立用户；请先创建基础邮箱，再由基础所有者添加别名。
- 添加别名及 account 插入辅助入口要求基础邮箱存在、未删除且属于同一用户。
- 外部及站内收件统一使用基础邮箱所有权解析：合法同所有者精确别名仍保留独立文件夹；不同所有者的历史别名不能抢走基础地址未来来信；缺失/已删除基础邮箱时不投递给孤立别名。
- 发件也检查别名基础所有权，防止历史冲突地址继续冒用他人的基础邮箱。
- 未知收件人仍服从既有拒收/catch-all 配置，但不会归属至抢注者。
- 不自动删除历史独立 +用户、不迁移历史邮件。请先用 `mail-worker/tests/alias-audit.sql` 列出 cross-user、orphan、deleted-base 和独立 +用户，由管理员核实。已经收到的验证码/重置邮件不会被代码补丁撤回，受影响外部账户应检查登录记录并更新恢复方式。

## 本地验证（不会部署）

```bash
node --test mail-worker/crypto-utils.node-test.mjs mail-vue/oauth-flow.node-test.mjs
node --experimental-vm-modules --test mail-worker/telegram-preview.security.test.mjs mail-worker/tests/*.test.mjs
```

注意：原项目 `mail-worker/package.json` 中名为 `test` 的脚本实际执行 `wrangler deploy`，不要把它当成本地测试。

这些回归测试及本地打包不等于 Cloudflare、Telegram 移动 WebView、真实多用户数据库及远程存储的端到端验收；上线前还需在隔离测试环境完成验证。
