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
  directives drain ready deterministic work immediately; `GET /api/state`
  schedules due ticks and awaits a short drain when characters or jobs are due,
  so a watched world keeps moving between the daily Hobby cron runs. Overnight
  disconnected autonomy still depends on that daily cron (or a later Pro/Queue
  scheduler).
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
- LLM calls remain disabled. The intended later provider is OpenRouter.
- Privy per-user wallets, Stripe Crypto Onramp, and MPP payment authorization
  remain later milestones and must preserve server-side spend policy.

## Remaining work

1. `packages/hosted/src/hosted-neon.test.ts` exercises live `FOR UPDATE SKIP
   LOCKED` claims against Neon when `AGENT_WORLD_NEON_TEST_URL` or
   `DATABASE_URL` is set. CI still skips it until a disposable database URL is
   available in the workflow.
2. Disconnected autonomy faster than daily still depends on Hobby cron limits.
   Spectator polls now schedule due ticks and drain them; a Pro cron or Vercel
   Queue would raise the unattended cadence.
3. Structured JSON logs, per-user mutation rate limits, event retention, and
   optional `OPERATOR_ALERT_WEBHOOK` alerts are implemented. Wire a real
   webhook in Vercel before opening signup broadly. Custom domain DNS for
   `agent.narula.xyz` still needs the GoDaddy `domains.dns:update` scope.
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
