# 静态站与单进程网关部署

此目录包含网站部署配置；是否已上线以实际目标主机和域名检查为准。VPS 只运行 Nginx 和一个 Node 24 网关，不处理 PDF、字体或 OCR。

## 发布约定

- 发布目录示例：`/opt/pdf-editor/releases/<version>`；`current` 指向启用版本。
- 静态产物：`apps/web/dist`；目前是否具备下载/帮助等页面以实际构建产物为准。
- 网关配置只使用 `apps/gateway` 内的配置样例及其实际校验 schema，不维护第二套可能不兼容的配置。
- 启动契约：`/opt/pdf-editor/runtime/node --max-old-space-size=256 apps/gateway/dist/cli.mjs --host 127.0.0.1 --port 8787 --config /etc/pdf-editor/gateway.config.json --credential-file %d/gemini`。网关已在开发机构建为 JS bundle；发布时带上该产物、非敏感配置和对应 Linux Fastify 生产依赖。不在 VPS 上编译 PDF 或运行 TypeScript 构建。
- 目标主机需将匹配的 Linux x64 Node 24 可执行文件安装到 `/opt/pdf-editor/runtime/node`，不能使用 Ubuntu 24.04 自带的 Node 18 代替。
- 不设置项目 `.env` 的 `NODE_ENV`/`PORT`；端口由启动参数指定。

## 凭证和绑定

部署前读取账号 registry，绑定实际 VPS、域名、签名与下载资源。不猜测域名或赞助账号。上游使用指定的 `https://gemini.openjk.space` / `gemini-3.8-flash-high`，不替换成 Google 官方域名。

密钥由部署过程在内存中从 vault 读取，写入服务器受限凭证文件 `/etc/pdf-editor/credentials/gemini`（目录 0700，文件 root:root 0400），由 `LoadCredential` 注入。不要把实际密钥粘贴进命令行、Shell 历史、项目配置或日志。宿主受限凭证文件本身包含秘密，不能宣传为“密钥从不落盘”。

## Nginx

将模板包含在 `http {}` 内。先准备真实证书和站点目录，再启用 TLS 配置；不能在证书路径尚不存在时先 reload。

- 网页两条 AI 路由分别 512 KiB / 3 MiB；桌面 SDK 的 `/api/agent/v1/messages` 和 `/api/agent/v1/messages/count_tokens` 使用 3 MiB 上限并共用网关预算。请求与响应关闭缓存/缓冲，禁止代理响应临时文件。HTTP/1.1 支持请求流式传递。
- 桌面发行资源可由 `node scripts/prepare-desktop-runtime.mjs --service-url https://<已绑定域名>/api/agent` 生成公开 `agent-service.json`，只含URL/model；SDK使用公开占位值，不向安装包下发上游密钥。这不是账号鉴权，公共服务仍需服务端预算限制。当前配置模板未据此自动部署。
- 200 秒反代读写超时大于应用的 180 秒总时限。真实 IP 用 `$remote_addr` 覆盖，不透传客户端自报地址。
- `/editor/` 才可 SPA 回退；缺失 WASM、字体、JS 和 JSON 返回真实 404。
- 仅 `name.<16–64 位 SHA-256 前缀>.ext` 的约定资源长期 immutable；其他名称重新验证，不因位于 assets/engines/fonts 目录就当作内容哈希。
- 模板关闭 AI access log；错误日志和网关日志仍应仅保留必要元数据，不输出正文。禁用缓冲是配置意图，是否没有临时文件仍需从实际 Nginx 入口验证。

## 上线前直接验证

1. `nginx -t`；确认 MIME、路由、真实 404 和正常 SSE。
2. 10 路接近 512 KiB 文本体 + 2 路接近 3 MiB 图像体，包含慢上游和代表性输出；超额请求解析前拒绝。
3. 测 RSS、heap、external/Buffer、取消与释放。256 MiB 堆 / 512 MiB cgroup 是候选值，不是容量结论。
4. 验证真实断开会取消上游、正常完成不会被误取消；检查代理没有请求/响应临时文件。
5. 仅为网关日志配置 7 天保留，不擅自更改整台服务器其他服务的日志策略。

生产部署、证书续期与容量验收分别记录；模板语法检查和健康检查不能代替负载验收。
