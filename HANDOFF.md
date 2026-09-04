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
- Upstash QStash marketplace integration (`upstash-qstash-sky-ferry`, schedule
  `scd_7Bh9SNqWXfhxev2WiSYTGQ5CwNxb`): every-10-minute authenticated
  `GET /api/jobs/run` (`Authorization: Bearer $CRON_SECRET`), independent of
  Vercel Hobby's daily-cron limit. Manage it in the Upstash console or via
  `QSTASH_TOKEN` (a Vercel-provisioned Production env var) against
  `https://qstash.upstash.io/v2/schedules`.
- `.github/workflows/check.yml`: `pnpm check`, with live Neon SKIP LOCKED when a
  test database URL is available (secret or disposable neon.new).
- `.github/dependabot.yml` and `.github/workflows/dependabot-auto-merge.yml`:
  weekly npm Dependabot groups plus squash auto-merge for low-risk updates.
- `ROADMAP.md`: architecture, findings, validation state, and later milestones.
- `AGENTS.md`: layout notes for future agents. `CLAUDE.md` and `CURSOR.md` are
  symlinks to it so every tool's convention-named file stays in sync.

## Important design decisions

- Hosted reads are public; mutations require a server-verified Neon Auth
  session. Character ownership is an immutable auth user ID, never a name from
  the client.
- Admin routes require `AGENT_WORLD_ADMIN_USER_IDS`.
- Vercel Hobby rejected an every-minute cron. Character creation and owner
  directives drain ready deterministic work immediately; `GET /api/state`
  schedules due ticks and awaits a short drain when characters or jobs are due,
  so a watched world keeps moving between cron runs. Upstash QStash (see
  above) hits production every 10 minutes with the authenticated
  `CRON_SECRET`. Daily Hobby cron remains the backup. An earlier GitHub
  Actions workflow (`hosted-ticks.yml`) did the same job but was removed in
  favor of QStash to avoid two independent triggers on the same 10-minute
  cadence.
- Production Auth traffic uses `/api/auth/*` as a same-origin proxy. The proxy
  authenticates its server-to-server hop with Neon's own origin so Better Auth
  origin validation succeeds.
- Phaser is lazy-loaded. This reduced the initial minified bundle from about
  1.84 MB (506 KB gzip) to 624 KB (170 KB gzip). The associated repository
  issue was closed after verification.
- Conversation *lines* are private to participants and admins. The public log
  still records that people met. Owner directive text is not copied into public
  event details.
- Users may create up to five characters. Names remain globally unique.
- `AGENT_WORLD_INVITE_ONLY=true` restricts character creation to
  `AGENT_WORLD_INVITE_USER_IDS` and admins. Leave it false until invites are
  configured in Vercel.
- The Neon serverless HTTP driver exposes `transaction()` as a query batch, not
  an interactive `BEGIN`. `NeonStore` only uses `sql.begin` when that API
  exists; otherwise mutations run as consecutive statements and uniqueness is
  enforced by Postgres constraints.
- Privy per-user wallets, Stripe Crypto Onramp, and MPP payment authorization
  remain later milestones and must preserve server-side spend policy.

## Remaining work

1. `AGENT_WORLD_ADMIN_USER_IDS` is still unset in Vercel; no user has signed up
   for real yet (only leftover `aw-smoke-*@example.com` rows in
   `neon_auth.user`). Sign up, then set that env var to the resulting user ID
   and redeploy.
2. Optional: set GitHub Actions secret `AGENT_WORLD_NEON_TEST_URL` to a
   disposable Neon branch. `.github/workflows/check.yml` already runs the live
   SKIP LOCKED test when that secret exists, and otherwise tries neon.new before
   skipping. Neon MCP login is not available here.
3. Ops: `OPERATOR_ALERT_WEBHOOK` has no real destination in this environment;
   leave it unset. `agent.narula.xyz` still does not resolve; it needs GoDaddy
   `domains.dns:update`. `AGENT_WORLD_INVITE_ONLY` is false in production.
4. Follow `ROADMAP.md` for OpenRouter, then Privy + Stripe Crypto Onramp + MPP
   (issues #3 #4 #5). Do not enable paid calls in CI or ordinary preview
   deployments.

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
