# Agent World handoff

## Shipped state

The deterministic hosted slice is live at:

- `https://agent-world-lovat.vercel.app`

The Vercel project is connected to this repository and deploys `main` to
production. Its Neon marketplace resource supplies Postgres and Neon Auth
environment variables. Migrations `db/migrations/0001_hosted.sql` and
`db/migrations/0002_hosted.sql` are checked in; `NeonStore.ensureSchema()`
applies additive 0002 statements at runtime.

Production verification completed successfully for the first hosted milestone
(auth, owned character, deterministic exploration, owner directive). Follow-up
work added a testable hosted engine, autonomy ticks, operator controls, and
product surfaces that do not require Stripe, Privy, or OpenRouter.

The implementation is primarily in:

- `packages/hosted`: HTTP handler, job runner, MemoryStore tests, NeonStore.
- `api/index.ts`: Vercel Function entry that re-exports the hosted handler.
- `db/migrations/0001_hosted.sql` and `0002_hosted.sql`: hosted Postgres schema.
- `apps/web/src/auth.ts`, `apps/web/src/api.ts`, and `apps/web/src/App.tsx`:
  Neon Auth, session-derived ownership, polling, and authenticated controls.
- `vercel.json`: monorepo build, API rewrite, daily Hobby-compatible cron.
- `.github/dependabot.yml` and `.github/workflows/dependabot-auto-merge.yml`:
  weekly npm Dependabot groups plus squash auto-merge for low-risk updates.
- `ROADMAP.md`: architecture, findings, validation state, and later milestones.
- `CURSOR.md`: layout notes for future agents.

## Important design decisions

- Hosted reads are public; mutations require a server-verified Neon Auth
  session. Character ownership is an immutable auth user ID, never a name from
  the client.
- Admin routes require `AGENT_WORLD_ADMIN_USER_IDS`.
- Vercel Hobby rejected an every-minute cron. Character creation and owner
  directives drain ready deterministic work immediately; `GET /api/state` may
  start a short background drain when due work exists; a daily cron remains for
  maintenance. A durable higher-frequency scheduler is still limited by Hobby.
- Production Auth traffic uses `/api/auth/*` as a same-origin proxy. The proxy
  authenticates its server-to-server hop with Neon's own origin so Better Auth
  origin validation succeeds.
- Phaser is lazy-loaded. This reduced the initial minified bundle from about
  1.84 MB (506 KB gzip) to 624 KB (170 KB gzip). The associated repository
  issue was closed after verification.
- Conversation *lines* are private to participants and admins. The public log
  still records that people met.
- Users may create up to five characters. Names remain globally unique.
- LLM calls remain disabled. The intended later provider is OpenRouter.
- Privy per-user wallets, Stripe Crypto Onramp, and MPP payment authorization
  remain later milestones and must preserve server-side spend policy.

## Remaining work

1. Hosted integration tests for cross-user ownership, admin boundaries,
   concurrent queue claims, stale job recovery, and transaction semantics now
   live in `packages/hosted/src/hosted.test.ts` against MemoryStore. A live
   Neon SKIP LOCKED matrix is still a useful addition when a disposable
   database URL is available in CI.
2. Disconnected autonomy faster than daily still depends on Hobby cron limits.
   The queue, leases, ticks, and opportunistic drain are in place; a Pro cron
   or Vercel Queue would raise the cadence.
3. Structured JSON logs, per-user mutation rate limits, event retention, and
   optional `OPERATOR_ALERT_WEBHOOK` alerts are implemented. Wire a real
   webhook in Vercel before opening signup broadly.
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
