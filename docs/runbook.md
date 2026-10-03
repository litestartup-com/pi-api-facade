# Runbook — operating a pi-api-facade node

One facade process = one Pi node. The manager talks to it over the frozen
apiproxy contract; the facade embeds the Pi SDK and hosts every session of
that node in-process.

## Requirements

- Node.js >= 22.19.0 (pure ESM; the Pi SDK constraint). The facade runs
  TypeScript sources directly via Node type stripping — there is no build step.
- `git` on PATH (the per-run audit hook shells out to it; a workspace that is
  not a git repo simply produces no commits).
- A provider credential for the node, e.g. `DEEPSEEK_API_KEY`.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PI_FACADE_ENGINE` | yes | `sdk` for production; `fake` for development (loud warning) |
| `PI_FACADE_API_KEYS` | yes | Comma-separated northbound API keys. Empty = every authenticated call is rejected (fail closed) |
| `DEEPSEEK_API_KEY` | yes (deepseek nodes) | Read by Pi at runtime; the facade never stores it |
| `PI_AGENT_DIR` | recommended | Per-node Pi home (auth/models/settings/sessions). Default `~/.pi/agent` is shared — always set one directory per node |
| `PI_FACADE_MODEL` | no | Default model for new sessions (`provider/model`, default `deepseek/deepseek-flash`) |
| `PI_FACADE_HOST` / `PI_FACADE_PORT` | no | Bind address (default `127.0.0.1:3091`). Exposing beyond loopback is an ops decision; firewall to the manager's egress IP |
| `PI_FACADE_ALLOW_FULL_ACCESS` | no | Unlocks the `danger-full-access` tier (default off; ops nodes only) |

## First boot (per node)

1. Pick a node home and a workspace:
   - `PI_AGENT_DIR=/var/lib/pi-api-facade/agent` (Linux) or a dedicated directory (Windows)
   - workspace directory initialized as a git repo (`git init` + first commit) —
     the audit hook commits each run that leaves changes.
2. Seed the node settings so headless runs load workspace resources instead of
   silently skipping them (project trust cannot prompt headless):
   ```json
   // <PI_AGENT_DIR>/settings.json
   { "defaultProjectTrust": "always" }
   ```
   (`scripts/start-facade.ps1` creates this file when missing.)
3. Generate a northbound key (e.g. `openssl rand -hex 16`) and export it as
   `PI_FACADE_API_KEYS`; put the same value in the manager's `.env` under the
   endpoint's `key_ref` name.
4. Start the facade:
   - Windows: `scripts/start-facade.ps1` (see below)
   - Linux: `node src/index.ts` under a supervisor; see
     `deploy/pi-api-facade.service.example` (systemd).
5. Verify: `curl http://127.0.0.1:3091/api-gw/v1/health` → `{"ok":true,...}`.

To give the node a DAC voice, put a `SYSTEM.md` (or skills) under the
workspace's `.pi/` directory — project trust from step 2 lets them load.

## Manager wiring (hand-written endpoint)

`manager.config.yaml` (see `docs/contract-map.md` §1 for the full annotation):

```yaml
endpoints:
  pi01:
    url: http://127.0.0.1:3091
    driver: apiproxy
    prefix: /api-gw/v1/proxy      # MUST be explicit: the default prefix is
                                  # rewritten to the dead /api native path
    key_ref: PI01_FACADE_KEY
    sandbox_base: http://127.0.0.1:3091/api-gw/v1
    sandbox_key_ref: PI01_FACADE_KEY
    # no spawn block: the facade lifecycle is supervised outside the manager (v1)
agents:
  pi01:
    name: Pi 01
    endpoint: pi01
    workspace: /srv/dac/workspaces/pi01
    sandbox_mode: workspace-write
    provider: deepseek            # billing pin — MANDATORY, see below
    model: deepseek-flash
pricing:
  models:
    deepseek-flash:               # Pi catalog ids need their own rows
      off_peak: { input: 0.22, output: 0.66, cache_read: 0.007 }
      peak:     { input: 0.44, output: 1.32, cache_read: 0.014 }
```

**Billing pin (mandatory).** The manager's continued-run path has no host
model report; without the agent-level `provider`/`model` pin the ledger prices
`null` from the second run of a chat onward. The pin lands through
`session.selectModel` every turn and the facade returns the host-confirmed
pair. The pricing table needs a row for the **reported model name** (Pi
catalog ids such as `deepseek-flash`); an unknown model prices null — an
honest gap, never a wrong zero.

Restart the manager after config changes; a healthy boot means the config
validated (endpoints, key refs, agent workspace paths).

## Smoke verification

```bash
FACADE_URL=http://127.0.0.1:3091 FACADE_KEY=<key> SMOKE_CWD=<workspace> \
  node scripts/smoke-facade.mjs
```

Walks the manager's exact call pattern against the live facade with a real
provider round (streaming, a real tool call, usage on the wire, history
replay, pending-card surface). **It spends real tokens** — one small run.

## Restart / upgrade / rollback

- **Restart**: stop the process, start again. Sessions persist as JSONL under
  `<PI_AGENT_DIR>/sessions`; the next prompt cold-resumes them, and history
  replays from the tree. Open approval cards are in-memory and **are lost on
  restart** (parity with the DSH facade) — re-ask the model if a card was mid-flight.
- **Upgrade Pi**: the dependency is pinned exact. Upgrade = edit
  `package.json`, `npm install`, re-verify the pinned-version facts (the DAC
  version matrix discipline: full-chain smoke before promotion), commit the
  lockfile.
- **Rollback a manager wiring mistake**: restore the config/env backups taken
  before the change and restart the manager; the facade keeps running
  independently and is unaffected by manager restarts.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE` on boot | A previous facade process still holds the port. On Windows a killed shell wrapper can orphan the `node` child: find the real owner (`Get-NetTCPConnection -LocalPort <port>` → PID), verify it is the facade, then stop that PID. |
| Manager shows the node unreachable | Facade down, or firewall between manager and node, or key mismatch (manager gets 401). `curl` the health endpoint from the manager host. |
| 401 from the facade | `x-api-key` mismatch or empty `PI_FACADE_API_KEYS` (fail closed by design). The 401 body never contains "provisions a key" — that string would trigger the manager's DSH-specific retry. |
| Runs bill `null` cost | Missing agent billing pin, or no `pricing.models` row for the reported model name (see above). |
| Workspace `.pi` resources ignored | Headless project trust: set `{"defaultProjectTrust":"always"}` in `<PI_AGENT_DIR>/settings.json`. |
| No audit commits | Workspace is not a git repo, the run left no changes (clean runs never commit), or `git` is missing on PATH (hook failures are logged, never fatal). |
| Chat hangs with no frames | Check the facade is on the pinned Pi version and the model credential works; run the smoke script. The manager's silence backstop (5 min) cancels the turn loudly. |
