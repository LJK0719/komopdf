# Gateway

本目录同时提供网页基础 AI 的既有 Gemini 原生接口，以及供桌面端官方 Claude Agent SDK 使用的受限 Anthropic Messages 兼容入口。当前文档只描述源码约定，不表示服务已经部署。

## Claude Agent SDK 入口

SDK 的 `baseUrl` 指向本站的 `/api/agent`，例如：

```text
ANTHROPIC_BASE_URL=https://example.com/api/agent
ANTHROPIC_API_KEY=pdf-editor-public
```

`pdf-editor-public` 只是满足 SDK 参数要求的公开占位值，不是秘密、账号或用户身份。网关不建立 JWT/账号体系，也不依据客户端 `Authorization`、`x-api-key` 或占位值分配独立额度。

可用路由：

- `POST /api/agent/v1/messages`
- `POST /api/agent/v1/messages/count_tokens`

网关固定使用 `gateway.config.json` 中已有的 `provider.baseUrl`、`provider.model` 和服务器凭证。客户端不能选择上游地址或模型；客户端认证头会被丢弃，随后由服务器注入 `x-api-key`、`anthropic-version` 及经过检查的 `anthropic-beta`。`count_tokens` 只转发到同一上游；上游不支持时会保留相应 HTTP 失败，不在本地估算或伪造 token 数。

## 限制

- 入口只接受未压缩的 `application/json`。
- Messages 的消息、客户端工具定义、工具结果和 SSE 事件保持 Anthropic 结构转发，但 `model` 始终替换为服务器配置值。
- 不接受原始 `document`/PDF 内容块。PDF 只能在本地完成授权后的文本提取或页面渲染，再将允许的文字或图像上下文放入请求。
- 不开放远程 MCP、container 或 Anthropic 服务端工具；Agent SDK、工具执行、PDF 读取和计算都在桌面端运行，网关只中转模型请求。
- Agent 请求使用共享的全局、来源和每分钟 admission 预算，并在解析请求体前保守占用现有 image 并发子槽位；网页和桌面没有两套独立无限额度。
- `limits.agentBodyBytes` 限制 Agent JSON 请求体；`limits.agentMaxOutputTokens` 限制 Messages 的 `max_tokens`。图像只接受内联 base64 的 PNG/JPEG/WebP/GIF，数量与单图大小继续复用 `imageCount` 和 `imageFileBytes`。
- 请求继续复用现有连接超时、总 deadline、上游帧/流大小限制、客户端取消、下游 backpressure 和无正文 usage 日志。
- 上游错误正文及请求/响应认证头不会回传；中转错误只返回不含凭证的 Anthropic 风格错误结构。

## 配置字段

`gateway.config.json` 新增：

```json
{
  "limits": {
    "agentBodyBytes": 3145728,
    "agentMaxOutputTokens": 32768
  }
}
```

其余上游、凭证和共享资源限制沿用既有配置。不要把服务器 credential 写入桌面包、网页代码或客户端环境。
