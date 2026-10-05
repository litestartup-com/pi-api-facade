# Changelog

All notable changes to this project are documented here.
Format follows Keep a Changelog; versions follow SemVer.

## [Unreleased]

### Added

- OpenAI-compatible endpoints out of the box: `PI_OPENAI_BASE_URL` (+
  `PI_OPENAI_API_KEY` / `PI_OPENAI_PROVIDER` / `PI_OPENAI_MODELS`) makes boot
  synthesize a `models.json` provider entry (`api: openai-completions`) for any
  endpoint speaking the OpenAI chat-completions API — OpenAI itself,
  OneAPI/new-api proxies, vLLM, SGLang, Ollama. The key is referenced by Pi's
  `$ENV` interpolation (never on disk); the default provider id `openai` keeps
  the built-in catalog model ids; an entry already in the file always wins.
  Compose passes the new envs through, the entrypoint/launcher credential
  warnings generalized, runbook + READMEs document the flow including the
  manager-side billing-pin follow-through.
- Cross-implementation conformance (D4): the gateway repo now hosts
  `conformance/conformance.mjs` — one zero-dependency suite asserting the
  intersection both facades guarantee (carrier codes, envelope invariants,
  sandbox semantics, the mux downstream-only rule, and with `RUN_PROMPT=1`
  the billing invariant). This repo's CI runs it against the Pi facade
  through the front door (gateway checkout pinned by commit); the gateway's
  CI runs the same file against its live stack. Verified against the real
  facade in both modes (17/18 checks, real-model turn included).
- Question cards via the `ask_user` bridge (D3): Pi has no built-in question
  surface, so the facade registers an `ask_user` custom tool (TypeBox schema:
  questions with id/text/options/multiSelect — the manager card UI's shape).
  The tool suspends on the CardTable, which broadcasts `question/requested`
  and waits for the frozen respond wire (answers / cancelled decline / TTL →
  expired), then returns the operator's answers as the tool result. Active in
  every sandbox tier (asking is never dangerous). Proven offline end to end:
  scripted stub provider → tool call → wire card → respond → answer back in
  the transcript → run completes.
- Web demos on the Pi stack (D2): `examples/demos/compose.demos.yml` overlay —
  KB Studio + Support widget single-sourced from the gateway repo (build context
  via `GATEWAY_DIR`), re-pointed at the Pi facade with pi personas
  (`examples/demos/seed/`) and this repo's docs as the knowledge base
  (`scripts/sync-demo-docs.mjs`); `scripts/demo-smoke.mjs` drives both BFFs the
  way their browsers do (pages, file CRUD, doc sync, SSE chat rounds, history)
  and runs in CI against the fake engine.
- Standalone docker stack (D1): thin runtime image (`docker/Dockerfile` —
  node + git/ripgrep, non-root, healthcheck; nginx/demo never enter it per the
  deployment red line), `docker-compose.yml` mirroring the proven gateway
  topology (nginx front door on HTTP_PORT 8090, facade port unpublished,
  locations.d add-on hook, agent-home volume, workspaces bind mount, China
  mirror envs), fail-closed entrypoint (boots only with keys; seeds
  `defaultProjectTrust: always`), `.env.example`, `.dockerignore`,
  `openapi.yaml` for the northbound surface, and `scripts/compose-smoke.mjs`
  (fake-engine wiring smoke) wired into CI as a compose-up job.
- `health` now also reports `status` and `upstream` fields (demo-BFF probe
  parity — finding G2 of the standalone-plan D0 survey).

## [0.1.0] - 2026-10-03

First accepted release: verified end to end against a production DAC manager
with real deepseek-flash rounds (streaming chat, tool round, history replay,
per-run billing incl. continued runs, git audit commits).

### Added

- Operations pack (F7): `docs/runbook.md` (first boot, manager wiring with the
  mandatory billing pin, smoke, restart/upgrade/rollback, troubleshooting),
  `scripts/start-facade.ps1` (Windows launcher with project-trust seeding),
  `deploy/pi-api-facade.service.example` (systemd), and an offline CI workflow
  (`.github/workflows/ci.yml`).

- `scripts/smoke-facade.mjs`: wire-level smoke against a running facade with a
  real provider (the manager's exact call pattern, a real tool round, usage and
  audit-commit assertions). Manual only — it spends tokens.
- Sandbox tiers + restart recovery + audit hook (F5): tier pinning applies
  tool allowlists live (`read-only` drops bash/write/edit — Pi cannot constrain
  a shell, so the honest read-only tier removes it; container mounts remain the
  real boundary); a fresh engine on the same agentDir lists/resumes persisted
  sessions with full history; every run that leaves workspace changes produces
  exactly one `pi run` git commit at agent_settled (clean runs commit nothing,
  hook failures never block chat).
- Mux + card chain (F4): `events.mux` WebSocket broadcast on both contract
  paths (server-request envelopes, `method = payload.type`, downstream-only —
  any client frame closes 1008; handshake auth rejects with 401 before
  upgrade); `MuxHub` taps the engine's global frame stream (`subscribeAll`).
- Real respond endpoints backed by a `CardTable`: strict rpcId + sessionId +
  approvalId matching (mismatch = not-pending, never a guess), cancelled-decline
  semantics, bad-response for unknown outcome vocabulary, `answerer/pending`
  recovery listing the original frame payloads verbatim, and a 15-minute card
  TTL resolving as `expired`.
- Approval bridge: an inline Pi extension (`tool_call` hook) consults the
  operator gate for danger-full-access sessions only; a rejection blocks the
  tool with the reason in the transcript and the run still completes.
  Per-session tier pinning via `POST {prefix}/sessions/{id}/sandbox-mode`
  (live sessions only → 409 otherwise; danger requires the node unlock).
- Offline end-to-end proof: a scripted stub provider issues a real bash tool
  call; the danger-tier session routes it through a card, and a
  workspace-write session never consults the gate.
- Pi SDK engine (F3): `SdkPiEngine` embeds `createAgentSession` in-process with
  per-node `agentDir` isolation (explicit SessionManager under
  `<agentDir>/sessions`), cold-session resume via `SessionManager.open` replay,
  live frame translation (one wire turn per run: `turn/start` on the first Pi
  turn_start, `turn/end` on `agent_settled`), usage field renames with cost
  dropped, model catalog/selectModel mapping, and `PI_FACADE_ENGINE=sdk` +
  `PI_FACADE_MODEL` boot wiring. Verified offline against a stub
  OpenAI-compatible provider (no keys, no external network): exact frame
  sequence, history replay, two concurrent sessions without crossover.
- Pi → wire translation module with recorded live fixtures (`translate-pi.ts`,
  `test/fixtures/pi-events.json` from the P0 deepseek-flash round).
- Contract map and golden wire fixtures (F1): `docs/contract-map.md` citing the
  manager consumer code line by line; `test/fixtures/wire-samples.json` built
  from the P0 live round; 10 fixture invariants asserted manager-side.
- HTTP contract core (F2): `POST {prefix}/proxy/:method` with x-api-key
  constant-time auth (env-provisioned, fail closed), the manager whitelist
  (403 outside / `method_not_migrated` for unimplemented), client-request →
  server-response envelopes (business outcomes always HTTP 200), respond stubs
  on both paths, permanently-closed `POST {prefix}/key`, `PiEngine` port with
  the in-memory `FakePiEngine`, and explicit engine selection
  (`PI_FACADE_ENGINE=fake` or refuse to boot).
- Service scaffold (F0): env-driven config (`src/config.ts`), fastify app
  factory with `{prefix}/health` (`src/server.ts`), graceful-shutdown entrypoint
  (`src/index.ts`), node:test suite, bilingual README skeletons, MIT license,
  repo discipline in `AGENTS.md`.

### Changed

- Approval outcome vocabulary widened to the full DSH set —
  `allowed-once | rejected | cancelled | unavailable` all settle the card
  (anything but allowed-once blocks the tool); finding G3 of the D0 survey.

### Fixed

- Prompt issuance is serialized per session and a concurrent cold resume
  attaches exactly once: two racing prompts could hit Pi's instance mutex
  before the streaming flag flips (the loser's message was dropped), and two
  racing resumes could open a second AgentSession on the same JSONL file.
- Audit commits are serialized per workspace (the DSH-node commit-lock
  parity): concurrent runs settling on the same workspace raced the git
  index and the loser dropped its commit silently.
- Cold history replay lost tool cards: the JSONL tree persists tool calls only
  as assistant-message `toolCall` content blocks, so `historyEntriesToEvents`
  now synthesizes `tool/call` events from them and groups entries into runs
  (one `turn/start…turn/end` pair per run, reason from the run's last assistant
  stopReason). Found by the first real-provider smoke; regression test recorded
  from the live scenario.
