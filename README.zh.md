# pi-api-facade

[English](./README.md) | 中文

把 [Pi](https://pi.dev) coding agent 的会话面装进 DAC 冻结的 apiproxy 契约后面，
让 [DAC](https://github.com/litestartup-com/hellodac) manager 像管 DSH 节点一样
管 Pi 节点的 HTTP 门卫。

**状态：v0.1.0 —— 2026-10-03 验收通过。** 已对照生产 DAC manager 用真实
`deepseek-flash` 回合端到端验证：流式聊天、工具调用、历史回放、逐 run 记账
（含续轮）、每 run 一次 git 审计提交。契约细节见
[docs/contract-map.md](./docs/contract-map.md)，运维见
[docs/runbook.md](./docs/runbook.md)，发布历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 架构

```
DAC manager ──(冻结 apiproxy 契约, HTTP/WS)──> pi-api-facade（本仓库）
                                                 └── Pi SDK（进程内嵌入）
                                                      └── AgentSession × N
```

- **对北**：与 `ohdsh-api-facade`（dsh-api-gateway）冻结的 wire 契约完全一致——
  API-key 鉴权、fail-closed 方法白名单、client-request/server-response 信封、
  `events.mux` WebSocket、respond 回执、按会话沙箱模式。
- **对南**：Pi TypeScript SDK（`@earendil-works/pi-coding-agent` 的
  `createAgentSession`，版本由 DAC 版本矩阵钉死）。一个门卫进程并发承载
  一个节点的全部会话。

## 快速开始（Docker 独立栈）

```bash
cp .env.example .env         # 填 DEEPSEEK_API_KEY + PI_FACADE_API_KEYS（openssl rand -hex 16）
mkdir -p workspaces
docker compose up -d --build
node scripts/compose-smoke.mjs   # 接线自检（FACADE_URL/FACADE_KEY 见脚本头注释）
```

nginx 前门监听 `HTTP_PORT`（默认 **8090**，刻意避开 DAC 生产面），是唯一对外
端口：只代理 `/api-gw/`，其余一律 404；门面端口不发布。会话工作区在
`./workspaces`（客户端 session.create 传 `cwd=/workspace/<名字>`）；节点的 Pi
数据目录是 `agent-home` 卷。完整手册见 [docs/runbook.md](./docs/runbook.md)。

### 网页 demo

`examples/demos/compose.demos.yml` 在同一个 nginx 前门后叠加两个网页 demo——
**KB Studio**（`/kb/`，知识库管理，AI 管理员会话钉 `workspace-write` 档）与
**智能客服**（`/cs/`，基于同一知识库的只读客服；知识库即本仓库文档）。demo
应用单一真相源在
[ohdsh-api-facade](https://github.com/litestartup-com/dsh-api-gateway)（契约的
参考实现），本 overlay 只把它们指向 Pi 门面、并换上 pi 人格/文档种子。

```bash
git clone https://github.com/litestartup-com/dsh-api-gateway ../dsh-api-gateway  # 或在 .env 里设 GATEWAY_DIR
node scripts/sync-demo-docs.mjs
mkdir -p workspaces/kb workspaces/cs
docker compose -f docker-compose.yml -f examples/demos/compose.demos.yml up -d --build
DEMO_BASE=http://127.0.0.1:8090 node scripts/demo-smoke.mjs
```

Pi 运行时相对 DSH 栈的口径：问题卡走 `ask_user` 自定义工具（由模型决定何时
提问——两个 demo 和 manager 里都能渲染成卡片）；审批卡只在 danger 档触发——
KB demo 的自动放行策略在 Pi 栈上是空转（真正的护栏是沙箱钉档，与 DSH 同理）。

## 快速开始（裸进程）

```bash
npm install
npm start
```

需要 Node.js >= 22.19.0（纯 ESM，Pi SDK 的约束）。

## 配置

全部走环境变量（无配置文件、密钥不落盘）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_FACADE_HOST` | `127.0.0.1` | 绑定网卡；放开到非 loopback 是运维动作 |
| `PI_FACADE_PORT` | `3091` | HTTP 端口 |
| `PI_FACADE_PREFIX` | `/api-gw/v1` | 路由前缀（与冻结契约一致） |
| `PI_FACADE_API_KEYS` | — | 北面鉴权 API 密钥（逗号分隔）；为空 = 所有需鉴权请求一律拒绝（fail closed） |
| `PI_FACADE_ENGINE` | — | `sdk` 启动生产 Pi SDK 引擎（进程内、多会话）；`fake` 启动内存开发引擎（带醒目警告）；未设置则拒绝启动 |
| `PI_FACADE_MODEL` | `deepseek/deepseek-flash` | 新会话默认模型，格式 `provider/model` |
| `PI_AGENT_DIR` | `~/.pi/agent` | 本节点的 Pi agent 数据目录（auth/models/settings/sessions），一节点一目录 |
| `PI_FACADE_ALLOW_FULL_ACCESS` | `false` | 是否在本节点解锁 `danger-full-access` 沙箱档 |
| `DEEPSEEK_API_KEY` | — | provider 密钥，由 Pi 运行时读取；门卫不存储 |
| `OPENAI_API_KEY` | — | Pi 原生读取的内置 `openai` provider 密钥 |
| `PI_OPENAI_BASE_URL` | — | 指向任意 **OpenAI 兼容端点**（OpenAI 官方、OneAPI/new-api 中转、vLLM、SGLang、Ollama……）。启动时门面自动合成 `models.json` provider 条目（`api: openai-completions`），再用 `PI_FACADE_MODEL=<provider>/<model-id>` 选中 |
| `PI_OPENAI_API_KEY` | — | 该端点的密钥，以 `$PI_OPENAI_API_KEY` 环境插值引用——**密钥不落盘**；无鉴权端点（Ollama）可不填 |
| `PI_OPENAI_PROVIDER` | `openai` | 合成的 provider id。默认覆盖内置 `openai` 的端点并保留其目录模型 id；自定义 id 需配 `PI_OPENAI_MODELS` |
| `PI_OPENAI_MODELS` | — | 目录里没有的模型 id（逗号分隔，如 vLLM 起的别名），追加/替换到该 provider |

> **与 dsh-api-gateway 共用词汇**：上表每个 `PI_OPENAI_*` 变量都同时接受中立名——
> `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_PROVIDER`、`OPENAI_MODELS`
> （另有 `OPENAI_MODEL` 单模型简写）；`PI_FACADE_MODEL` 同样接受 `FACADE_MODEL`。
> 这正是姊妹项目 [dsh-api-gateway](https://github.com/litestartup-com/dsh-api-gateway)
> 独立栈使用的名字——同一份运维/manager 配置可以同时喂 Pi 节点和 DSH 节点。
> 两套同时出现时 `PI_*` 优先。一处语义差异要诚实标注：本项目的
> `PI_OPENAI_MODELS` 是在目录上**追加**，DSH 栈的列表是**整体替换**——对着自家
> 网关时反正都要显式列出它真正供的模型，实际效果一致。

## 开发

```bash
npm run check   # eslint + tsc --noEmit + node --test
```

全部测试离线可跑：单测用 fake 引擎，集成测试用真 Pi SDK + 本地脚本化 stub
provider（无密钥、不出网）。CI：`.github/workflows/ci.yml`。

纪律（见 `AGENTS.md`）：测试先行；每次提交前 `npm run check` 常绿；
依赖钉精确版本；commit message 英文。

## 运维

- [docs/runbook.md](./docs/runbook.md) —— 首次启动、manager 接线（含**必做的
  记账钉版**）、smoke 验证、重启/升级/回滚、排障表。
- [openapi.yaml](./openapi.yaml) —— 北向面的 OpenAPI 3 文档（mux WebSocket
  在 info 描述里注明）。
- `docker/` + `docker-compose.yml` —— 独立栈（薄运行镜像；nginx 前门；
  `PI_FACADE_ENGINE=fake` 接线测试模式）。
- `scripts/start-facade.ps1` —— Windows 启动器（节点级 agent 目录、project
  trust 预置、密钥处理）。
- `deploy/pi-api-facade.service.example` —— Linux 节点的 systemd 单元。
- `scripts/smoke-facade.mjs` —— 对运行中门面的 wire 级 smoke（真实 provider，
  花 token，仅手动）。
- `scripts/compose-smoke.mjs` —— compose 栈的 fake 引擎接线 smoke（不花
  token，可进 CI）。
- [docs/contract-map.md](./docs/contract-map.md) —— 冻结契约逐端点对照，
  全部引用 manager 消费端源码。
- 跨实现**一致性套件**在 gateway 仓（`conformance/`，CI 按 commit 钉版）：
  同一套断言两个门面都必须过——它红了就说明两种运行时在冻结契约上漂移了。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
