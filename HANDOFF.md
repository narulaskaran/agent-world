# Agent World handoff

Local-first Agent World is on `main`. Clone, `pnpm install`, `pnpm start`, open
`http://127.0.0.1:4310`. With no keys it runs deterministically. Optional
`OPENROUTER_API_KEY` powers LLM dialogue, memories, and JEV decisions.
Optional `pnpm wallet:setup` enables local mppx paid tools.

Vercel should build `apps/site` (see `vercel.json`). The interactive world is
not deployed; it is served by the local server from `apps/web`.

The previous hosted stack (Vercel Functions, Neon, Neon Auth, QStash) is on
`archive/hosted`. Restore it with `git switch archive/hosted`. Notes from that
era are in `docs/archive`.

Still open (human-only): record `apps/site/public/demo.mp4`, run
`pnpm jev:probe` with a real key, fund a real mppx wallet if you want paid
tools, and point `agent.narula.xyz` at the static site.
