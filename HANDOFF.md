# Agent World handoff

## Shipped state

The deterministic hosted slice is live at:

- `https://agent-world-lovat.vercel.app`

The Vercel project is connected to this repository and deploys `main` to
production. Its Neon marketplace resource supplies Postgres and Neon Auth
environment variables. Migration `db/migrations/0001_hosted.sql` has been
applied to production.

Production verification completed successfully:

- `/api/health` reports both database and auth dependencies healthy.
- Public world state is readable without a session.
- Anonymous character mutations and job execution return `401`.
- A real Neon Auth signup produced a server-verified session.
- That user created an owned character, ran deterministic exploration, sent an
  owner directive, and received a persisted deterministic response/event.
- The smoke character, auth user, and related events were removed afterward.
- `pnpm check` passes: 28 tests, all workspace typechecks, and production builds.
- `.github/dependabot.yml` and `.github/workflows/dependabot-auto-merge.yml` are
  on `main`. Patch and minor Dependabot PRs auto-merge except the
  `neon-and-drizzle` group and any update whose dependency names include
  `drizzle` or `neondatabase`.

The implementation is primarily in:

- `api/index.ts`: catch-all Vercel Function, same-origin Neon Auth proxy,
  authorization, Neon queries, deterministic queue processing, health/admin
  endpoints.
- `db/migrations/0001_hosted.sql`: hosted Postgres schema.
- `apps/web/src/auth.ts`, `apps/web/src/api.ts`, and `apps/web/src/App.tsx`:
  Neon Auth, session-derived ownership, polling, and authenticated controls.
- `vercel.json`: monorepo build, API rewrite, and daily Hobby-compatible cron.
- `.github/dependabot.yml` and `.github/workflows/dependabot-auto-merge.yml`:
  weekly npm Dependabot groups plus squash auto-merge for low-risk updates.
- `ROADMAP.md`: architecture, findings, validation state, and later milestones.

## Important design decisions

- Hosted reads are public; mutations require a server-verified Neon Auth
  session. Character ownership is an immutable auth user ID, never a name from
  the client.
- Admin routes require `AGENT_WORLD_ADMIN_USER_IDS`.
- Vercel Hobby rejected an every-minute cron. Character creation and owner
  directives drain ready deterministic work immediately; a daily cron remains
  for maintenance. A durable higher-frequency scheduler is still future work.
- Production Auth traffic uses `/api/auth/*` as a same-origin proxy. The proxy
  authenticates its server-to-server hop with Neon's own origin so Better Auth
  origin validation succeeds.
- Phaser is lazy-loaded. This reduced the initial minified bundle from about
  1.84 MB (506 KB gzip) to 624 KB (170 KB gzip). The associated repository
  issue was closed after verification.
- LLM calls remain disabled. The intended later provider is OpenRouter.
- Privy per-user wallets, Stripe Crypto Onramp, and MPP payment authorization
  remain later milestones and must preserve server-side spend policy.

## Remaining work

1. Add hosted integration tests for cross-user ownership, admin boundaries,
   concurrent queue claims, stale job recovery, and Postgres transaction
   semantics. The production smoke covered one authenticated user, not the full
   adversarial matrix.
2. Replace request-coupled deterministic draining with a durable scheduler or
   queue if disconnected autonomy needs a cadence faster than daily.
3. Add structured error reporting, rate limits, event retention, and operator
   alerts before opening signup broadly.
4. Follow `ROADMAP.md` for OpenRouter, then Privy + Stripe Crypto Onramp + MPP.
   Do not enable paid calls in CI or ordinary preview deployments.

## Useful continuation commands

```bash
pnpm check
git status --short --branch
vercel project inspect agent-world
vercel ls agent-world
curl -fsS https://agent-world-lovat.vercel.app/api/health
gh issue list --state open
```

Before committing, follow the repository's zero-PII policy and run the configured
pre-commit checks if present. Never commit pulled Vercel/Neon environment files.
