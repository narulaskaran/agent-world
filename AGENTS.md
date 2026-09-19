# Agent World — agent notes

## Layout

- `apps/site`: static marketing page (Vite + Three.js, no backend).
- `apps/web`: Vite + React + Three.js client. Talks to the local API and `/ws`.
- `apps/server`: local Fastify + WebSocket runtime (`LocalRuntime` + `WorldEngine`).
- `packages/shared`: Zod contracts, locations, waypoints, hashing helpers.
- `packages/db`: SQLite `WorldStore` used by the local server and its tests.

## Local-first behaviour

- Clone, `pnpm start`, open `http://127.0.0.1:4310`. No accounts or sessions.
- Persistence is SQLite. The server binds `127.0.0.1` by default.
  Admin routes are unauthenticated; do not expose the port.
- The client uses `/ws` snapshots. No polling.
- Keys are environment variables only (`.env`, gitignored).

## Decision precedence

Scheduled decisions: JEV (if `OPENROUTER_API_KEY` and
`AGENT_WORLD_JEV_DECISIONS` is not `false`) → OpenRouter LLM (if key) →
deterministic. Directives and events skip JEV: OpenRouter LLM (if key) →
deterministic. JEV never writes free text.

Dialogue and memories use OpenRouter if the key is set, else MPP if
`AGENT_WORLD_LIVE_MPP=true`, else deterministic lines. Web search and avatars
stay MPP-only and off by default.

## Commands

```bash
pnpm install
pnpm check
pnpm start
pnpm dev
pnpm smoke
```

Optional: `pnpm wallet:setup`, `pnpm jev:probe --dry-run` (a human runs the
live probe with a real key).
