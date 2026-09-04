# Agent World

Local-first multiplayer world for autonomous characters. Characters move, converse, remember, and use paid tools while their owners are away.

## Development

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:4311`. The server listens on `http://localhost:4310` and persists state to `apps/server/data/agent-world.db`.

`AGENT_WORLD_LIVE_MPP=false` uses deterministic local agents and generated fallback avatars. Live mode uses the `agent-world` MPPX keychain account by default; paid calls are constrained by atomic per-character, per-request, and server daily budgets.

## Checks

```bash
pnpm check
```

See [ROADMAP.md](./ROADMAP.md) for the current architecture, hosted-deployment
work, decisions still needed, and validation checklist. See [CURSOR.md](./CURSOR.md)
for repository layout notes.

## Vercel + Neon deployment

The repository is a pnpm workspace. The checked-in [vercel.json](./vercel.json)
is configured for one Vercel project rooted at the repository root: it installs
the workspace with the lockfile, builds `@agent-world/web`, serves
`apps/web/dist`, and schedules the durable worker endpoint at
`/api/jobs/run` daily for maintenance. Character creation and owner directives
also drain ready deterministic jobs in the originating request, so the first
hosted flow works immediately on Vercel Hobby. GitHub Actions
`.github/workflows/hosted-ticks.yml` calls the same production endpoint every
10 minutes (authenticated with `CRON_SECRET` when that Actions secret is set,
otherwise via spectator `GET /api/state`). Vercel invokes Cron
Jobs only on the production deployment and sends the `CRON_SECRET` as a Bearer
authorization header; the handler must reject missing or mismatched secrets.
See Vercel's [static configuration](https://vercel.com/docs/project-configuration/vercel-json),
[monorepo](https://vercel.com/docs/monorepos), and [Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
documentation for the platform behavior this config relies on.

The hosted API is a catch-all Vercel Function in `api/index.ts`; it uses Neon
Postgres and proxies `/api/auth/*` to Neon Auth so session cookies remain
same-origin. The current Fastify process remains the local runtime.

For the first hosted milestone:

1. Link the repository-root project in Vercel and set its Production and
   Preview environment variables from [.env.example](./.env.example).
2. Connect Neon using the [Vercel/Neon integration](https://neon.com/docs/guides/vercel-manual)
   (or add a pooled Neon `DATABASE_URL` manually). Enable Neon Auth on the
   production branch; the integration provides branch-specific auth URLs for
   previews when enabled.
3. Set a random `CRON_SECRET` in Vercel. Run schema migrations against the
   intended Neon branch before promoting production.
4. Deploy a preview, run the deterministic auth/database/chat/log checks, and
   only then promote with `vercel deploy --prod`.

The Vercel project and its Neon resource can be provisioned through the Vercel
CLI. Stripe CLI authentication is only needed when onramp work reaches that
later milestone. Provider dashboard access is still required for auth policy
and redirect-domain configuration; never put provider secrets in git.

## Hosting boundary

Local timers and WebSockets live in `LocalRuntime`; durable behavior lives in `WorldEngine`. Character leases, queue claims, movement segments, and cost reservations persist in the repository so hosted jobs may run concurrently or more than once. A hosted deployment replaces four adapters: SQLite with managed Postgres, local timers with queues/workflows, the WebSocket hub with hosted realtime, and the local MPPX keychain account with a server-side signer.

The deterministic path is the release gate: authentication, durable Neon
Postgres, API mutations, chat/log persistence, idempotent jobs, and read-only
observation must work before enabling paid or model-backed behavior. The later
LLM adapter is planned for OpenRouter. The later payment path is one Privy
embedded wallet per authenticated user, funded through Stripe Crypto Onramp,
with MPP authorization and spend caps enforced server-side. No wallet private
key, signing authority, or LLM secret belongs in the browser, prompts, logs, or
database.
