# Agent World — agent notes

## Layout

- `apps/web`: Vite + React + Phaser client. Same-origin `/api` in production.
- `apps/server`: local Fastify + WebSocket runtime (`LocalRuntime` + `WorldEngine`).
- `packages/shared`: Zod contracts, locations, waypoints, hashing helpers.
- `packages/db`: SQLite `WorldStore` used by the local server and its tests.
- `packages/hosted`: hosted HTTP handler, job runner, MemoryStore tests, NeonStore.
- `api/index.ts`: Vercel Function entry that re-exports `createProductionHandler()`.
- `db/migrations`: checked-in Postgres SQL. `0002_hosted.sql` is also applied at
  runtime by `NeonStore.ensureSchema()`.
- `.github/workflows/check.yml`: `pnpm check` plus optional live Neon claims.

## Hosted behavior

- Public reads; mutations require a Neon Auth session cookie.
- Ownership is the auth user id. Users may have up to five characters.
- Conversation *lines* are private to participants; the fact that people met stays public.
- Deterministic jobs live in `character_queue`. Claims use `FOR UPDATE SKIP LOCKED`.
- Stale `processing` rows are returned to `pending` when their lease (`not_before`) expires.
- Hobby cron is daily (`/api/jobs/run`). Mutations drain immediately. `GET /api/state`
  schedules due ticks and awaits a short drain when due characters or jobs exist.
  Upstash QStash repeats an authenticated `GET /api/jobs/run` unattended every
  10 minutes (`Authorization: Bearer $CRON_SECRET`); see `HANDOFF.md`.
- `AGENT_WORLD_INVITE_ONLY=true` plus `AGENT_WORLD_INVITE_USER_IDS` can close
  character creation without disabling public observation.
- Do not enable OpenRouter, Privy, or Stripe in this codebase until those milestones.

## Commands

```bash
pnpm install
pnpm check
```
