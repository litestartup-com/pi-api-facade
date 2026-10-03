# AGENTS.md — pi-api-facade repository discipline

## Language rules (public-facing repository)

1. **Git commit messages: English only**, starting from the very first commit.
   First line `type: summary` (imperative mood); body explains *why*.
2. **Code is English**: comments, JSDoc, test titles, identifiers, log lines,
   error messages. No other language appears in `src/`, `test/`, `scripts/`,
   or `docs/`.
3. **User-facing docs are bilingual, split by file**: `README.md` (English) and
   `README.zh.md` (Chinese) carry the same content; update both in the same
   commit when behavior, endpoints, or configuration change. No mixed-language
   inside one README.

## Verification gates

1. `npm run check` (eslint + `tsc --noEmit` + `node --test test/`) must be green
   before every commit.
2. **Tests first**: write the failing test before implementing a feature or
   fixing a bug; the test must demonstrably fail before the fix.
3. Upstream behavior is evidence-based: do not guess what the Pi SDK does —
   verify against the pinned `node_modules/@earendil-works/pi-coding-agent`
   (its `docs/`, `dist/*.d.ts`, and sources) and record the finding where it is
   contract-relevant (`docs/contract-map.md`).

## Dependencies

- External dependencies are **pinned to exact versions** (`npm install
  --save-exact`). The lockfile is committed.
- `@earendil-works/pi-coding-agent` is pinned deliberately: Pi iterates fast.
  Upgrading it requires re-verifying every recorded upstream fact and a
  full-chain smoke — never a floating range.

## Secrets

- Never commit `.env`, API keys, or session data. Credentials come from the
  process environment at runtime (`DEEPSEEK_API_KEY`); the facade itself stores
  nothing secret.

## Architecture pointers

- Northbound contract: the frozen apiproxy wire (endpoint-by-endpoint mapping
  in `docs/contract-map.md`). When in doubt, the manager's consumer code
  (`dsh-agent-manager/src/upstream/*`, published as
  [litestartup-com/hellodac](https://github.com/litestartup-com/hellodac)) is
  the source of truth, not prose.
- Southbound: `PiEngine` interface; the only v1 implementation is the
  in-process SDK engine. An RPC-child engine is a documented fallback, not
  built.
- Operations: `docs/runbook.md`. Release history: `CHANGELOG.md`.
