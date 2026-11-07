<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center"><strong>基于 Cloudflare 的一站式邮箱服务平台</strong></p>
    <p align="center">
        <a href="https://www.cloudflare.com/" target="_blank">
            <img src="https://img.shields.io/badge/Cloudflare-F38020?labelColor=F38020&amp;color=F38020&amp;logo=cloudflare&amp;logoColor=white" alt="Cloudflare" />
        </a>
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail?logo=github&amp;logoColor=white" alt="releases" />
        </a>
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>  
    </p>
    <p align="center" >
        <a href="https://skymail.ink">在线演示</a> · <a href="https://docs.skymail.ink">部署文档</a> ·
        <a align="center"><a href="README-en.md">English</a> | 简体中文</a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
        <a href="https://hellogithub.com/repository/1b1da1f9ae4c4175baa3d762b4e0ba41" target="_blank">
            <img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=1b1da1f9ae4c4175baa3d762b4e0ba41" alt="HelloGitHub" />
        </a>
    </p>
</p>


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台，本项目支持部署到 Cloudflare Workers ，降低服务器成本，搭建自己的邮箱服务

## 项目展示

| ![](/doc/demo/demo.jpg)  | ![](/doc/demo/demo1.jpg) |
|--------------------------|--------------------------|
| ![](/doc/demo/demo2.jpg) | ![](/doc/demo/demo3.jpg) |


## 推荐项目

<table>
  <tr>
    <td valign="middle">
      <a href="https://github.com/pixtalelab/pixtale">
        <img width="30" src="https://img.022335.xyz/logo.png" alt="Pixtale" align="middle">
      </a>
    </td>
    <td valign="middle">
      <a href="https://github.com/pixtalelab/pixtale">Pixtale</a>
    </td>
    <td valign="middle">
      一个自托管云存储相册应用
    </td>
  </tr>
</table>

## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：集成 Cloudflare Email 和 Resend 发送邮件，支持群发

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔢 验证码识别**：使用Workers AI，自动识别邮件验证码 

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **📜 更多功能**：正在开发中...



## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件发送：** [Cloudflare Email](https://developers.cloudflare.com/email-service/) / [Resend](https://resend.com/)

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## 使用 Resend 收信

除了 Cloudflare Email Routing，也可以使用 Resend 接收邮件，邮件正文、附件、内嵌图片、别名归属和收信规则复用现有处理流程。

1. 在 Resend 为域名开启 **Receiving**，按其控制台要求配置收信用 MX 记录。同一个域名不要同时配置 Cloudflare Email Routing 和 Resend 的收信 MX；如需并存，请使用不同子域名。该域名也必须加入本项目 Worker 的 `domain` 配置。
2. 为 Worker 设置以下 **Secrets**（不要写入仓库或前端配置）：
   - `RESEND_API_KEY`：有读取收件邮件权限的 Resend API Key（仅发送权限的 Key 不适用）。它独立于系统设置中用于发件的域名 Token。
   - `RESEND_WEBHOOK_SECRET`：Resend Webhook 的签名密钥（`whsec_...`）。
3. 在 Resend 创建 Webhook，地址填写 `https://你的邮箱网站域名/api/webhooks`，订阅 **`email.received`**。原有发件状态事件也可使用同一地址；更新后所有事件都需要有效签名，原有用户需补充签名密钥。
4. 重新部署 Worker，向已存在的本地邮箱发送一封含附件的邮件，检查收件箱及 Resend Webhook 投递日志。若允许保存未注册收件人的邮件，则仍按现有「无收件人」设置处理。

```bash
cd mail-worker
pnpm exec wrangler secret put RESEND_API_KEY
pnpm exec wrangler secret put RESEND_WEBHOOK_SECRET
```

实现会通过 Resend API 获取原始 MIME 邮件，再下载正文和附件；下载超时为 30 秒，原始邮件上限为 40 MiB，依赖该邮件的 `raw.download_url` 可用。失败返回非 2xx，供 Resend 重试。D1 自动创建 `resend_inbound_delivery` 表，按 Resend 邮件 ID + 实际收件地址记录完成状态，避免正常重试/并发重复入库；入库与投递记录不属于同一事务，极端进程中断仍存在重复窗口，不保证严格 exactly-once。记录暂不自动清理，需保留以支持历史事件重放去重。

**边界说明：** Resend 到达 Webhook 时已接受 SMTP 邮件，收信关闭、黑名单及权限拒收仅在本系统丢弃，无法向原发件人返回 SMTP 拒收。支持 Telegram 和应用 Webhook 通知，但不支持现有基于 Cloudflare `message.forward()` 的自动邮箱转发。邮件入库后的通知失败会记录日志，不会重复投递邮件，通知本身不保证自动补发。

参考：[Resend 收信域名](https://resend.com/docs/dashboard/receiving/custom-domains)、[收信 Webhook](https://resend.com/docs/dashboard/receiving/create-receiving-webhook)、[Webhook 签名](https://resend.com/docs/webhooks/verify-webhooks-requests)。

## 目录结构

```
cloud-mail
├── mail-worker                    # worker后端项目
│   ├── src
│   │   ├── api                    # api接口层
│   │   ├── const                  # 项目常量
│   │   ├── dao                    # 数据访问层
│   │   ├── email                  # 邮件处理接收
│   │   ├── entity                 # 数据库实体
│   │   ├── error                  # 自定义异常
│   │   ├── hono                   # web框架配置、拦截器、全局异常等
│   │   ├── i18n                   # 语言国际化
│   │   ├── init                   # 数据库缓存初始化
│   │   ├── model                  # 响应体数据封装
│   │   ├── security               # 身份权限认证
│   │   ├── service                # 业务服务层
│   │   ├── template               # 消息模板
│   │   ├── utils                  # 工具类
│   │   └── index.js               # 入口文件
│   ├── pageckge.json              # 项目依赖
│   └── wrangler.toml              # 项目配置
│
├── mail-vue                       # vue前端项目
│   ├── src
│   │   ├── axios                  # axios配置
│   │   ├── components             # 自定义组件
│   │   ├── echarts                # echarts组件导入
│   │   ├── i18n                   # 语言国际化
│   │   ├── init                   # 入站初始化
│   │   ├── layout                 # 主体布局组件
│   │   ├── perm                   # 权限认证
│   │   ├── request                # api接口
│   │   ├── router                 # 路由配置
│   │   ├── store                  # 全局状态管理
│   │   ├── utils                  # 工具类
│   │   ├── views                  # 页面组件
│   │   ├── app.vue                # 入口组件
│   │   ├── main.js                # 入口js
│   │   └── style.css              # 全局css
│   ├── package.json               # 项目依赖
└── └── env.release                # 项目配置
```

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



