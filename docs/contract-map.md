# Contract Map — pi-api-facade ↔ DAC manager

> Phase F1 deliverable. The **manager's consumer code is the source of truth**,
> not prose: every obligation below cites the file that enforces it
> (`dsh-agent-manager/src/...`, state of 2026-10-02). The producer-side
> reference implementation is `dsh-api-gateway` (`ohdsh-api-facade`); where this
> document and the manager's parsing disagree, the manager wins.
>
> Golden wire samples: [`test/fixtures/wire-samples.json`](../test/fixtures/wire-samples.json).

## 1. Endpoint topology and auth

The manager endpoint config (`config.ts:93-106`) resolves to
`base = url + prefix`. Production facade wiring uses **two bases**:

| Base | Routes | Config fields |
| --- | --- | --- |
| `url + prefix` (rpc base) | `POST {base}/{method}`, `POST {base}/respond`, `WS {base}/events.mux` | `url`, `prefix`, `key_ref` |
| `sandbox_base` | `POST {sandboxBase}/sessions/{id}/sandbox-mode`, `GET {sandboxBase}/answerer/pending` | `sandbox_base`, `sandbox_key_ref` |

Plus, directly on the service prefix (one level above the rpc base):
`GET {prefix}/health` (unauthenticated, `public-api/key-probe` pattern) and
`POST {prefix}/key` (one-time self-provision — **permanently closed** on this
facade because keys are pre-seeded from the environment).

- Auth: `x-api-key` header on every authenticated call, including the WebSocket
  handshake (`mux.ts:249-262`, undici passes custom headers).
- **Config quirk (`config.ts:558-563`)**: `driver: apiproxy` with the *default*
  prefix `/api-gw/v1` is rewritten to `/api`. A facade endpoint must therefore
  write `prefix: /api-gw/v1/proxy` **explicitly**.
- **HTTP status discipline (`rpc.ts:125-131`)**: business outcomes are always
  HTTP 200; success/failure is `result.ok` alone. Non-200 means carrier-level
  failure (unknown path 404, bad JSON 400/415, handler crash 500).
  Exception: whitelist rejection is carrier-level (see §3).
- **401 bodies must not contain the string `provisions a key`** — the manager
  treats that hint as a known DSH-facade race and retries (`client.ts:214-226`).
  This facade pre-seeds keys and has no such race; return a generic 401 body.

Hand-written manager config for a Pi node (no `spawn` = unmanaged lifecycle,
no `access` = no native-GUI card; **no `dsh_version`** — matrix validation only
applies to `spawn` profiles, `config.ts:574`):

```yaml
endpoints:
  pi01:
    url: http://127.0.0.1:3091
    driver: apiproxy
    prefix: /api-gw/v1/proxy        # explicit; see quirk above
    key_ref: PI01_FACADE_KEY        # env var name holding the key
    sandbox_base: http://127.0.0.1:3091/api-gw/v1
    sandbox_key_ref: PI01_FACADE_KEY
agents:
  pi01:
    name: pi01
    endpoint: pi01
    workspace: /path/to/workspace
    sandbox_mode: workspace-write   # optional
    provider: deepseek              # REQUIRED for billing, see below
    model: deepseek-flash
```

**Billing pin (mandatory)**: the manager's continued-run path carries no host
model report (`runner.ts` `settleTurnModel` — the ledger-hole lesson of
2026-09-28). Without the agent-level `provider`/`model` pin, `usage_record`
prices `null` from the second run of a chat onward (the first run still bills:
the create response reports the host default). The pin lands via
`session.selectModel` each turn and the facade returns the host-confirmed pair,
so the ledger bills exactly what the host runs. Names are Pi catalog ids
(`deepseek` / `deepseek-flash` / `deepseek-v4-pro`), and the manager's
`pricing.models` table needs a row for the reported model name (an unknown
model prices null — honest gap, never a wrong zero).

## 2. RPC envelope (`rpc.ts:72-147`)

Request (manager → facade):

```json
{ "type": "client-request", "rpcId": "upstream-…", "method": "session.create", "payload": { } }
```

Response (facade → manager), discriminated on `result.ok`:

```json
{ "type": "server-response", "rpcId": "upstream-…",
  "result": { "ok": true, "value": { } } }
```

```json
{ "type": "server-response", "rpcId": "upstream-…",
  "result": { "ok": false, "error": { "code": "…", "message": "…", "details": null } } }
```

- `rpcId` should echo the request (the manager tolerates absence and falls back
  to its own id, `rpc.ts:147`).
- `ok:false` without an `error` branch = malformed → the manager throws. Always
  include `{code,message}`.

## 3. Method whitelist and v1 coverage

The manager calls only these 12 methods (`rpc.ts:24-40`). Facade obligations:

| Method | v1 | Params (manager sends) | Value (facade returns) |
| --- | --- | --- | --- |
| `session.create` | ✅ | `{cwd, agentPreset?}` (`translate.ts:224-227`) | `{sessionId, agentPreset?, provider?, model?}` (`client.ts:158-168`) |
| `session.prompt` | ✅ | `{sessionId, mode:"queue", content:[{type:"text",text}]}` (`translate.ts:234-238`) — **also cold-session attach/resume** | `{accepted:boolean}` (`client.ts:175-180`) |
| `session.cancel` | ✅ | `{sessionId}` | any (`ok:true`) |
| `session.history` | ✅ | `{sessionId}` | see §5 |
| `session.list` | ✅ | `{}` | see §6 |
| `session.models` | ✅ | `{}` | see §7 |
| `session.selectModel` | ✅ | `{sessionId, provider, model, reasoningEffort?}` (`client.ts:241-246`) | `{selected:{provider,model,reasoningEffort?}}` |
| `host.describe` | ✅ | `{}` | `{version, allowFullAccess, …}` — manager reads only these two (`client.ts:280-292`); return `version:"pi-<ver>"`, `allowFullAccess` from env, plus `protocol:"0.0.1"` and `runtime:"pi"` for parity |
| `session.rename` | ⛔ 501 | — | UI rename degrades on pi nodes (documented gap) |
| `session.fork` | ⛔ 501 | — | UI fork degrades (documented gap) |
| `session.updateQueue` | ⛔ 501 | — | queue steering UI degrades |
| `session.attachment` | ⛔ 501 | — | attachment upload degrades |

- Unimplemented-but-whitelisted → HTTP 200 with
  `{ok:false, error:{code:"method_not_migrated", message:…}}` (honest 501-style
  business error, mirroring dsh-api-gateway).
- Methods outside the whitelist → HTTP **403** `{"error":"method_not_allowed"}`
  (carrier-level, never reaching the engine; mirrors dsh-api-gateway).

## 4. Mux WebSocket (`mux.ts`, `translate.ts:29-90`)

- URL: `ws(s)://{base}/events.mux` (the manager derives it from the rpc base,
  `mux.ts:89-92`). The facade also registers `{prefix}/events.mux` for parity.
- **Downstream-only**: any frame received from the client → close with code
  1008 (dsh-api-gateway behavior).
- Envelope for every message:

```json
{ "type": "server-request", "rpcId": "…", "method": "…", "payload": { } }
```

- **`method` must equal `payload.type`** for card frames — the manager's card
  recovery matches `entry.method === 'question/requested' | 'approval/requested'`
  (`client.ts:327-331`). Use `method = payload.type` uniformly.
- `method: "stream/error"` is special: host-side fatal; the manager closes the
  socket and reconnects (`mux.ts:212-217`).
- Payload frame types — **closed set of 6** (`translate.ts:74-81`, discriminated
  zod union; unknown/misshapen payloads are dropped fail-loud, `mux.ts:122-131`):

| payload.type | Shape | Manager consumption |
| --- | --- | --- |
| `session/event` | `{sessionId, event, view?}` | `event` mapped by §8 `eventPayload` |
| `session/projection` | `{sessionId, key, value, seq?}` | keys consumed: `goal`, `tokenUsage`, `title`; all others dropped (`mux.ts:160-165`, `translate.ts:259-274,309-313`). v1 emits `title` and `tokenUsage`; never `goal` |
| `question/requested` | `{sessionId, questions:[{id, question, …}]}` | envelope `rpcId` becomes the manager's questionId (`translate.ts:331-336`). **v1: never emitted** (Pi has no question surface) |
| `question/resolved` | `{sessionId, questionRpcId, outcome}` | — |
| `approval/requested` | `{sessionId, approvalId, toolName, callId?, reason?}` | envelope `rpcId` = respond echo id; manager maps approvalId→rpcId (`mux.ts:149-153`, `translate.ts:351-358`) |
| `approval/resolved` | `{sessionId, approvalId, outcome}` | outcome vocabulary as emitted by the host (`translate.ts:365-371`) |

- Reconnect behavior (manager side): exponential backoff 3–30 s ±25% jitter,
  `stream_reconnected` frame injected to subscribers, cards lost during the
  outage recovered via `answerer/pending` (`mux.ts:71-82,188-201`). The facade
  must accept reconnects statelessly; it does **not** replay missed events
  (the manager reconciles via history).

## 5. `session.history` value (`client.ts:248-266`, `translate.ts:379-390`)

```json
{
  "events": [ { "event": { "type": "…", "seq": 1, "data": { } }, "view": null } ],
  "hasMore": false,
  "projections": {
    "asOfSeq": 0,
    "values": {
      "title": "…",
      "contextPressure": { "projectedTokens": 123, "contextWindow": 1000000 },
      "modelSelection": { "next": { "provider": "deepseek", "model": "deepseek-flash" } },
      "permissions": { "currentValue": "workspace-write" }
    }
  }
}
```

- `events[].event` entries are the bare session events of §8 (unwrapped by
  `translate.ts:379-390`, then mapped/compacted).
- `projections.values` consumed fields (`client.ts:76-102,258-260`):
  `title` (string|null), `contextPressure.projectedTokens|pressureTokens` +
  `contextWindow` (numbers → context %), `contextBreakdown`
  `{systemTokens,toolsTokens,messageTokens}` — **Pi has no breakdown → omit**
  (manager tolerates null), `modelSelection.next|lastUsed`
  `{provider,model,reasoningEffort?}`, `permissions.currentValue`
  (`read-only|workspace-write|danger-full-access`), `goal` — **omit** (null).
- `hasMore`: always `false` in v1 (full replay).
- The manager always reports `sessionState:'cold'` for apiproxy endpoints and
  auto-resumes via prompt (`client.ts:261-265`) — history needs no liveness.

## 6. `session.list` value (`translate.ts:392-428`)

```json
{ "items": [ { "sessionId": "…", "updatedAt": 1790950797140, "running": false,
               "blank": false, "projections": { "values": { "title": "…" } } } ] }
```

All fields except `sessionId` optional; title lives at
`projections.values.title`.

## 7. `session.models` value (`client.ts:104-128`)

```json
{
  "current": { "provider": "deepseek", "model": "deepseek-flash" },
  "routable": true,
  "groups": [ { "id": "deepseek", "name": "DeepSeek",
                "models": [ { "id": "deepseek-flash", "name": "DeepSeek Flash" } ] } ],
  "failures": []
}
```

- `current`/`reasoningEffort` nullable; `groups[].models[].reasoning.efforts`
  optional. Pi mapping: one group per provider from the model runtime;
  `reasoningEffort` ← Pi `thinkingLevel` (mapping table decided in F3:
  off/minimal/low/medium/high/xhigh/max → efforts list; default off).
- `failures[]` = providers that failed discovery `{id,name,message}` — v1 empty.

## 8. Session event shapes (`translate.ts:130-183` — the closed mapping)

`event = {type, seq?, data}`. Types the manager understands (anything else is
dropped):

| event.type | data shape | Pi source |
| --- | --- | --- |
| `user/message` | `{id, content:[{type:"text",text}]}` | user message entry |
| `assistant/chunk` | `{chunk:…}` — chunk variants: `{type:"text-delta",text}`, `{type:"reasoning-delta",text}`, `{type:"tool-call-delta",id,name,argumentsDelta}`, `{type:"usage",usage:<§9 shape>}`, `{type:"finish",reason:{kind}}` | `message_update` deltas |
| `assistant/message` | `{message:{content:[{type:"text"|"reasoning",text}]}, usage:<§9 shape>}` | `message_end` where `message.role==="assistant"` (**system/user message_end events must be filtered**, P0 live evidence) |
| `tool/call` | `{name, arguments}` — `arguments` is a **string** (JSON-serialized) | `tool_execution_start` |
| `tool/result` | `{message:{content:[{content:[{type:"text",text}], isError?}]}, error?}` — isError = `data.error` truthy or first block `isError` | `tool_execution_end` |
| `approval/asked` | `{id, toolName, callId?, reason?}` | facade-minted (approval bridge) |
| `approval/decided` | `{id, outcome}` | respond outcome |
| `approval/policy` | `{policy, source?}` | sandbox tier changes |
| `turn/start` | `{turn}` | `turn_start` |
| `turn/end` | `{turn, reason:{kind, error?:{message,code}, reason?:{kind}}}` | `turn_end`/`agent_end`: Pi stopReason → kind: `stop/end_turn→"completed"`, `aborted→"aborted"` (+`reason:{kind:"abort"}`), `error→"error"` (+`error:{message,code}`), `max_tokens→"max_tokens"` |

`seq`: monotonically increasing per session; the manager tolerates 0.

Cold history note: the JSONL tree persists neither turn nor tool-execution
events, so history replay synthesizes them — runs are grouped (user message →
last assistant before the next user message) into one turn/start…turn/end pair,
and `tool/call` events come from the assistant messages' `toolCall` content
blocks. Ordering inside a run matches the live stream.

## 9. Usage wire shape (`stream.ts:9-45`)

```json
{ "inputTokens": 453, "outputTokens": 2, "cacheReadTokens": 0,
  "cacheWriteTokens": 0, "reasoningTokens": 0 }
```

- **Field renames from Pi's `Usage`**: `input→inputTokens`,
  `output→outputTokens`, `cacheRead→cacheReadTokens`,
  `cacheWrite→cacheWriteTokens`, `reasoning→reasoningTokens`.
- **Pi's `cost` object is NOT put on the wire** — the manager computes money
  itself (peak/valley pricing engine). Double-accounting is a bug.
- `normalizeUsage` requires at least one of inputTokens/outputTokens to be a
  finite number, else the usage block is dropped (null) — never emit partial
  garbage.

## 10. Respond (`respond.ts`, `client.ts:339-376`)

`POST {base}/respond` (same auth; **not** a whitelist method):

```json
{ "type": "client-response", "rpcId": "<echoed envelope rpcId>",
  "result": { "ok": true, "value": { } } }
```

Receipt (always HTTP 200):

```json
{ "accepted": true }
```
```json
{ "accepted": false, "reason": "not-pending" }   // or "bad-response"
```

- Approval decision value: `{sessionId, approvalId, outcome:"allowed-once"|"rejected"}`
  — the facade matches pending by `rpcId` **and** validates `sessionId`+`approvalId`
  (`client.ts:364-376`); mismatch → `not-pending`.
- Question answer value (v1 unused): `{sessionId, answer:{answers:[{id, selected:[…], custom?}]}}`.
- Question decline wire form: `result = {ok:false, error:{code:"cancelled", …}}`
  (`client.ts:352-362`). Any other not-ok → `bad-response`.

## 11. Card recovery — `GET {sandboxBase}/answerer/pending` (`client.ts:304-337`)

Response:

```json
{ "pending": [ { "rpcId": "…", "method": "approval/requested",
                 "payload": { "type": "approval/requested", "sessionId": "…",
                              "approvalId": "…", "toolName": "…" } } ] }
```

- `payload` = the **original mux frame payload**, verbatim (the manager re-parses
  it with the same zod union and filters by sessionId).
- Any failure (404/500/network) → the manager treats recovery as empty; the
  endpoint must never block the main flow.
- v1: in-memory pending table; **cards are lost on facade restart** (parity with
  the DSH facade; documented).

## 12. Sandbox mode — `POST {sandboxBase}/sessions/{id}/sandbox-mode` (`client.ts:199-234`)

- Body `{ "mode": "read-only" | "workspace-write" | "danger-full-access" }`.
- `danger-full-access` requires `host.describe.allowFullAccess === true`, else
  reject (403 with a clear body).
- Session must be live: cold/unknown → **HTTP 409** `session_not_live`
  (dsh-api-gateway semantics). The manager calls this once after
  `session.create`, before the first prompt.
- Pi mapping (implemented in F4/F5): the tier is stored per session and applied
  live via `AgentSession.setActiveToolsByName`:
  - `read-only` → `[read, grep, find, ls]` — **bash is dropped**: Pi cannot
    constrain a shell, so an honest read-only tier removes it (degradation vs
    DSH, whose sandbox filters bash file writes in place);
  - `workspace-write` / `danger-full-access` → all built-ins
    `[read, grep, find, ls, bash, edit, write]`; the danger tier additionally
    routes every tool call through the approval card chain (§4/§10);
  - the real filesystem boundary in the containerized node form is the mount
    policy (RO vs RW workspace); the tool allowlist is defense in depth.
- Audit hook: every run that leaves workspace changes produces exactly one git
  commit at `agent_settled` (`pi run <id8> <iso>`, identity forced
  per-invocation); clean runs commit nothing, hook failures are logged and
  never block chat.

## 13. Known v1 gaps (honest, user-visible)

1. `session.rename` / `session.fork` / `session.updateQueue` /
   `session.attachment` → `method_not_migrated` (UI actions on pi nodes fail
   with an honest error).
2. No question cards (`ask_user_question` has no Pi counterpart); approval
   cards only, and only in the danger tier.
3. No goal projection, no context breakdown (both render as absent).
4. History is full-replay, `hasMore:false` always.
5. Pending-card table is in-memory (restart loses open cards).
