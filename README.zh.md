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

## 快速开始

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
- `scripts/start-facade.ps1` —— Windows 启动器（节点级 agent 目录、project
  trust 预置、密钥处理）。
- `deploy/pi-api-facade.service.example` —— Linux 节点的 systemd 单元。
- `scripts/smoke-facade.mjs` —— 对运行中门面的 wire 级 smoke（真实 provider，
  花 token，仅手动）。
- [docs/contract-map.md](./docs/contract-map.md) —— 冻结契约逐端点对照，
  全部引用 manager 消费端源码。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
