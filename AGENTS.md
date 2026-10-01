# Agent World — agent notes

## Layout

- `apps/site`: static marketing page (Vite + Three.js, no backend).
- `apps/web`: Vite + React + Three.js client. Talks to the local API and `/ws`.
- `apps/server`: local Fastify + WebSocket runtime (`LocalRuntime` + `WorldEngine`).
- `packages/shared`: Zod contracts (`.`), a zod-free `./world` entry the web
  client imports (locations, waypoints, hashing, `placeInSentence`), and `./hex`
  axial hex geometry shared by `apps/web` and `apps/site`.
- `packages/db`: SQLite `WorldStore` used by the local server and its tests.

## Local-first behaviour

- Clone, `pnpm start`, open `http://127.0.0.1:4310`. No accounts or sessions.
- Persistence is SQLite. The server binds `127.0.0.1` by default.
  Admin routes are unauthenticated; do not expose the port. An `onRequest`
  guard rejects foreign `Origin`s and unknown `Host`s (including `/ws`);
  `AGENT_WORLD_ALLOWED_HOSTS` adds names.
- The client uses `/ws` snapshots, published on change (coalesced) with a slow
  heartbeat. No polling. Snapshots omit memories and relationships (the
  inspector fetches them) and serve avatars by URL.
- World speed (`decisionScale`) and the global budget live in `world_state`
  and are edited from World settings; the env vars override them only when set.
- Conversations: one turn token per conversation (dedupe key
  `turn:<conversationId>`); transcripts live in `conversation_messages`;
  directives ride the character's own turn.
- Keys are environment variables only (`.env`, gitignored).

## Decision precedence

Scheduled decisions: JEV (if `OPENROUTER_API_KEY` and
`AGENT_WORLD_JEV_DECISIONS` is not `false`) → OpenRouter LLM (if key) →
deterministic ("keyless brain", `apps/server/src/deterministic.ts`).
Directives and events skip JEV: OpenRouter LLM (if key) → deterministic. JEV
never writes free text. Any provider failure falls back to deterministic for
that step; only `BudgetExhaustedError` propagates. Keyless calls never touch
the cost ledger.

Dialogue and memories use OpenRouter if the key is set, else MPP if
`AGENT_WORLD_LIVE_MPP=true`, else deterministic lines. Web search and avatars
stay MPP-only and off by default.

## Commands

```bash
pnpm install
pnpm check
pnpm format:check
pnpm start
pnpm dev
pnpm smoke
```

Optional: `pnpm wallet:setup`, `pnpm jev:probe --dry-run` (a human runs the
live probe with a real key).
