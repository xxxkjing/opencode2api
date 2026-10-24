# opencode2api

把 OpenCode Zen 官方模型（含免费模型）封装成 OpenAI 兼容 API 的 Docker 网关，**部署即用**。

基于对官方协议的直接逆向（2026-10-23）：官方端点 `opencode.ai/inference/openai/v1`，客户端认证头
（`x-opencode-client: cli` 等）会被 FreeTierError 门控深度绑定，**绕不过 TLS 指纹层**，因此网关内
跑官方 opencode CLI（serve 模式）作为模型后端——这是唯一稳定过门的方式。

## 架构

```
你的 OpenAI 客户端
   │  POST /v1/chat/completions  (Bearer OC2A_AUTH)
   ▼
网关 gateway.js (Node, 端口 10000, OpenAI 兼容)
   │  opencode serve 协议 (v2 /session + /message)
   ▼
opencode CLI serve (端口 4096, 官方客户端, 带 OPENCODE_API_KEY)
   │  官方推理端点 https://opencode.ai/inference/openai/v1
   ▼
OpenCode Zen 模型（93+ 个，含免费模型）
```

## 快速开始

```bash
# 1. 准备 .env
cp .env.example .env
vim .env            # 填 OC2A_AUTH 和 OPENCODE_API_KEY

# 2. 启动（首次构建约 2-5 分钟）
docker compose up -d

# 3. 测试（AUTH_TOK 换成你的 OC2A_AUTH 值）
curl http://127.0.0.1:10000/v1/models \
  -H "Authorization: Bearer AUTH_TOK"
curl http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer AUTH_TOK" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"hi"}]}'
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `OC2A_AUTH` | 是 | 网关鉴权（客户端请求时带 `Bearer OC2A_AUTH`） |
| `OPENCODE_API_KEY` | 是 | OpenCode 官方 key（`oc_sk_` 开头，https://opencode.ai/auth 获取）|
| `OPENCODE_CONSOLE_TOKEN` | 否 | OAuth access token（登录 console 后生成，比 API key 多一层 free tier 资格） |

## 可用模型

`GET /v1/models` 列出全部（从 opencode serve 的 config 实时拉取，约 93 个）。

免费模型（cost == 0）在当前账号下以 `whitelist` 为准：
`big-pickle`、`mimo-v2.6-flash-free`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`。
其余免费模型可能报 `Model access is disabled`（不在白名单）。

**免费额度**：free tier 有账号级额度，耗尽后报
`Free usage limit reached. Subscribe to OpenCode Go`——需要新账号/订阅才行。

## 端点

- `GET /v1/models` — 模型列表
- `POST /v1/chat/completions` — OpenAI 兼容对话（非流式）
- `GET /health` — 健康检查

## 已知限制

- **不支持流式**（stream: true 按非流式处理）。SSE 留待后续。
- 每次请求创建临时 session，完成后删除。
- opencode serve 首次启动会按需 npm 安装少量依赖（镜像构建时已预装主要列表），
  若运行时仍有网络请求，用 `docker exec -it opencode2api npm install ...` 预装或等它完成。
- 免费模型的行为（额度/白名单/地区锁）由 OpenCode 服务端决定，网关不保证可用性。

## 逆向笔记（为什么这么做）

- 官方真实端点是 `https://opencode.ai/inference/openai/v1`（不是 `zen/v1`）。
- 请求需带 `Authorization: Bearer <key>` + `x-opencode-client: cli` / `x-opencode-project: global` /
  `x-opencode-request: msg_*` / `x-opencode-session: ses_*` 等头。
- 裸 HTTP 带全头仍被 `FreeTierError` 拒（403）——服务端按 TLS 指纹识别客户端，仅官方 CLI（bun 运行时）放行。
- 登录后 `GET https://opencode.ai/console/api/config`（Bearer key）返回服务端下发配置：
  真实 URL、`x-opencode-org-id`、模型白名单、价格。
- 源码参考：github.com/anomalyco/opencode（v1.19.4，sst/opencode 已改名）。