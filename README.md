# pi-api-facade

English | [中文](./README.zh.md)

HTTP facade that exposes [Pi](https://pi.dev) coding agent sessions behind the
frozen DAC apiproxy contract, so a [DAC](https://github.com/litestartup-com/hellodac)
manager can run and operate Pi nodes exactly like DSH nodes.

**Status: v0.1.0 — accepted 2026-10-03.** Verified end to end against a
production DAC manager with real `deepseek-flash` rounds: streaming chat,
tool calls, history replay, per-run billing (including continued runs), and
per-run git audit commits. Contract details:
[docs/contract-map.md](./docs/contract-map.md) · operations:
[docs/runbook.md](./docs/runbook.md) · release history:
[CHANGELOG.md](./CHANGELOG.md).

## Architecture

```
DAC manager ──(frozen apiproxy contract, HTTP/WS)──> pi-api-facade (this repo)
                                                        └── Pi SDK in-process
                                                             └── AgentSession × N
```

- **Northbound**: the same wire contract `ohdsh-api-facade` (dsh-api-gateway)
  froze for the manager — API-key auth, fail-closed method whitelist,
  client-request/server-response envelopes, `events.mux` WebSocket, respond
  receipts, per-session sandbox mode.
- **Southbound**: the Pi TypeScript SDK (`createAgentSession` from
  `@earendil-works/pi-coding-agent`, version pinned by the DAC version matrix).
  One facade process hosts all sessions of one node concurrently.

## Quick start (Docker, standalone stack)

```bash
cp .env.example .env         # fill DEEPSEEK_API_KEY + PI_FACADE_API_KEYS (openssl rand -hex 16)
mkdir -p workspaces
docker compose up -d --build
node scripts/compose-smoke.mjs   # wiring check (needs FACADE_URL/FACADE_KEY env; see script header)
```

The nginx front door on `HTTP_PORT` (default **8090**, deliberately clear of the
DAC production surface) is the only external port; it proxies `/api-gw/` and 404s
everything else. The facade port is not published. Session workspaces live under
`./workspaces` (clients pass `cwd` as `/workspace/<name>`); the node's Pi home is
the `agent-home` volume. Full walkthrough: [docs/runbook.md](./docs/runbook.md).

## Quick start (bare process)

```bash
npm install
npm start
```

Requires Node.js >= 22.19.0 (pure ESM; the Pi SDK constraint).

## Configuration

All configuration is environment-driven (no config files, no secrets on disk):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_FACADE_HOST` | `127.0.0.1` | Bind interface. Exposing beyond loopback is an ops decision. |
| `PI_FACADE_PORT` | `3091` | HTTP port. |
| `PI_FACADE_PREFIX` | `/api-gw/v1` | Route prefix (matches the frozen contract). |
| `PI_FACADE_API_KEYS` | — | Comma-separated API keys for the northbound surface. Empty = every authenticated call is rejected (fail closed). |
| `PI_FACADE_ENGINE` | — | `sdk` boots the production Pi SDK engine (in-process, multi-session). `fake` boots the in-memory development engine (loud warning). Unset refuses to boot. |
| `PI_FACADE_MODEL` | `deepseek/deepseek-flash` | Default model for new sessions, as `provider/model`. |
| `PI_AGENT_DIR` | `~/.pi/agent` | Pi agent home for this node (auth/models/settings/sessions). One directory per node. |
| `PI_FACADE_ALLOW_FULL_ACCESS` | `false` | Unlock the `danger-full-access` sandbox tier on this node. |
| `DEEPSEEK_API_KEY` | — | Provider credential, read by Pi at runtime. Never stored by the facade. |

## Development

```bash
npm run check   # eslint + tsc --noEmit + node --test
```

The whole test suite is offline: unit tests drive a fake engine, integration
tests drive the real Pi SDK against a scripted local stub provider (no keys,
no external calls). CI: `.github/workflows/ci.yml`.

Discipline (see `AGENTS.md`): tests first; `npm run check` green before every
commit; dependencies pinned to exact versions; commit messages in English.

## Operation

- [docs/runbook.md](./docs/runbook.md) — first boot, manager wiring (including
  the mandatory billing pin), smoke verification, restart/upgrade/rollback,
  troubleshooting.
- [openapi.yaml](./openapi.yaml) — the northbound surface as an OpenAPI 3
  document (the mux WebSocket is annotated in the info description).
- `docker/` + `docker-compose.yml` — the standalone stack (thin runtime image;
  nginx front door; `PI_FACADE_ENGINE=fake` mode for wiring tests).
- `scripts/start-facade.ps1` — Windows launcher (per-node agent home, project
  trust seeding, key handling).
- `deploy/pi-api-facade.service.example` — systemd unit for Linux nodes.
- `scripts/smoke-facade.mjs` — wire-level smoke against a running facade with
  a real provider (spends tokens; manual only).
- `scripts/compose-smoke.mjs` — fake-engine wiring smoke for the compose stack
  (no tokens, CI-safe).
- [docs/contract-map.md](./docs/contract-map.md) — the frozen contract,
  endpoint by endpoint, cited against the manager's consumer code.

## License

MIT — see [LICENSE](./LICENSE).
