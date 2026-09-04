# Agent World roadmap

## Goal

Turn the validated local prototype into a hosted Vercel application with Neon
Postgres + Neon Auth, then add one Privy wallet per user and safe autonomous
spending. Preserve the game-first experience and deterministic test mode while
replacing machine-local infrastructure.

This document separates the confirmed local baseline from the selected hosted
direction and remaining work. Vercel + Neon/Neon Auth is the target for the
deterministic production milestone; OpenRouter, Privy, Stripe Crypto Onramp,
and MPP funding/spending remain later integrations.

## Current status and findings

- The repository now includes a root [vercel.json](./vercel.json) for the pnpm
  workspace: it builds `@agent-world/web`, serves `apps/web/dist`, and schedules
  `/api/jobs/run` daily. Vercel Hobby rejected the original every-minute cron;
  ready work is drained after character creation and owner directives, and
  `GET /api/state` schedules due ticks then awaits a short drain so a watched
  world keeps moving between cron runs.
- Vercel Cron invokes that path with an HTTP GET and authenticates it with a
  `CRON_SECRET` Bearer header. The hosted handler rejects missing or mismatched
  secrets.
- The Vercel project `agent-world` is linked to the GitHub repository and a Neon
  resource is connected. The initial Postgres migration has been applied. Neon
  Auth and database URLs are injected by the integration; the hosted API uses
  the serverless HTTP driver and a same-origin Auth proxy.
- The hosted implementation is present: public state reads, authenticated owner
  mutations, admin allowlisting, deterministic persisted jobs/chat/events,
  polling, health checks, hosted integration tests, stale-job recovery,
  structured logs, mutation rate limits, event retention, private conversation
  lines, multiple characters per user, export/import, moderation reports,
  reputation, persistent artifacts, a workshop location, a mobile layout,
  movement segments, spectator presence counts, and an optional invite-only
  creation gate. A live Neon SKIP LOCKED test runs when a disposable
  `DATABASE_URL` is provided. Production is live on Vercel. A production smoke
  test passed Neon Auth signup/session, owned character creation, deterministic
  exploration, an owner directive and persisted response, then cleaned up the
  temporary character and auth user.
- `agent.narula.xyz` is attached to the Vercel project. DNS still needs the
  Vercel-provided `agent` CNAME applied after the GoDaddy CLI receives its
  `domains.dns:update` OAuth scope.
- GitHub push-to-`main` production deployment is connected and verified.
  Dependabot update grouping is enabled; its auto-merge workflow is prepared
  locally but GitHub requires the CLI token to receive workflow-write scope.
- Deterministic production is the gate: auth, durable database state, API
  mutations, chat/log persistence, idempotent jobs, and public observation must
  pass before enabling LLM calls or paid MPP calls.

## Confirmed baseline

- pnpm/TypeScript monorepo: React + Phaser web client, Fastify API/WebSocket
  server, shared Zod contracts, and Drizzle + SQLite persistence.
- One authoritative shared world with anonymous spectators, one character per
  local username, autonomous movement, conversations, memories, directives,
  owner controls, admin controls, paid tools, and atomic virtual budgets.
- `WorldEngine` in `apps/server/src/world.ts` depends on the `WorldStore`
  persistence port exported by `packages/db/src/index.ts`.
- `LocalRuntime` in `apps/server/src/local-runtime.ts` owns only local timers and
  WebSocket listeners. Movement segments, character leases, queue claims, and
  cost reservations are persisted for concurrent, at-least-once job execution.
- Live MPP calls were proven locally with a dedicated developer-owned MPPX
  account. Normal development and tests use `AGENT_WORLD_LIVE_MPP=false` and
  must not spend funds.
- Current validation: `pnpm check` passes, including hosted handler tests, all
  TypeScript checks, and the production web/server builds.

Runtime data, generated builds, screenshots, dependencies, and `.env` are
intentionally ignored. A clone starts with a fresh world and no wallet secrets.

## Current local-only boundaries

- The local Fastify client historically used a character name as identity. The
  hosted UI now derives ownership from the Neon Auth session and immutable ID.
- Every mutation and every admin route in `apps/server/src/server.ts` is
  unauthenticated. This is intentional only for the trusted local demo.
- `WorldRepository` uses `better-sqlite3`, synchronous transactions, and local
  schema bootstrap SQL. SQLite is not suitable as deployed Vercel persistence.
- `LocalRuntime` uses permanent `setInterval` loops and an in-process WebSocket
  listener set. Serverless function lifetime cannot own either behavior.
- Paid requests shell out to the local MPPX CLI/keychain account. That signing
  path does not exist on Vercel and must not be emulated by shipping a local key.
- The Vite client defaults to localhost and derives its WebSocket URL from the
  API URL.

## Hosted delivery sequence

### 1. Lock product and security decisions

Decide these before selecting services or changing the schema:

1. Is the hosted world public to watch, invite-only to join, or open to anyone?
2. Neon Auth owns user sessions; confirm the exact client/server SDK and cookie
   configuration for this Vite + Vercel Functions topology.
3. Which Vercel-compatible background-job, realtime, and observability services
   fit alongside Neon?
4. Does each character spend directly from its owner's wallet, or does a
   platform wallet pay while the app maintains user balances? Do not blur these
   two economic models.
5. Which chain and asset will Privy, Stripe Crypto Onramp, Tempo, and the MPP
   endpoints all support? USDC on Tempo is the desired path, not yet a verified
   production integration.
6. Define production per-action, per-character/user, and global spend caps,
   funding rules, withdrawal/recovery behavior, and admin roles.

Re-verify current Vercel, Privy, Onramp, and provider capabilities rather than
relying on this dated planning snapshot.

### 2. Add Neon Auth authentication and authorization

- Add a durable user/account table keyed by the authentication provider's
  stable subject. Add `owner_id` to characters; keep public display names
  separate from identity.
- Verify the session on the server for every owner or admin mutation. Never
  trust a username, character name, wallet address, or client-supplied owner ID
  as authorization.
- Authorize character edits, directives, avatar regeneration, pause/resume, and
  deletion by immutable character ID plus authenticated owner ID.
- Protect admin budget, world pause, and reset routes with an explicit server-
  side role. Remove them from the public client unless the viewer is authorized.
- Decide which reads remain public. Anonymous observation can remain a product
  feature without granting mutation rights.
- Replace `agent-world-owner` localStorage as an authority. It may remain only
  as non-sensitive UI convenience after server identity is authoritative.
- Add unauthorized, cross-user, expired-session, and admin-boundary tests.

### 3. Migrate persistence to Neon managed Postgres

- Create a Postgres Drizzle schema and checked-in migrations; do not translate
  SQLite bootstrap SQL at runtime.
- Implement the existing `WorldStore` behavior against Postgres. Keep
  `WorldEngine` storage-agnostic and retain SQLite for fast local tests if useful.
- Use Neon's serverless driver over HTTP for one-shot serverless queries and
  transactions, or its compatible pooled interface when the selected handler
  requires it. Do not share long-lived TCP connections across invocations.
- Preserve atomic semantics for unique character ownership/names, character
  leases, queue claims, budget reservation/settlement, daily reset, event
  pruning, and conversation membership. Use transactions and conditional
  updates; a read followed by an unconditional write is not sufficient.
- Store timestamps consistently and choose the production budget-reset timezone
  deliberately.
- Add integration tests against real Postgres, including concurrent claims and
  budget reservations. Decide separately whether any local SQLite data needs a
  one-time migration; none is included in this repository.

### 4. Replace local timers and realtime

- Split the Fastify entrypoint from reusable route/domain handlers so Vercel
  requests do not start `LocalRuntime` timers on import.
- Invoke `runDueJobs` from a durable scheduler/queue. Jobs must reload state,
  claim work transactionally, tolerate duplicate delivery, and release or
  recover expired leases.
- Keep daily reset and maintenance distinct from high-frequency character work.
  Verify the chosen scheduler can support the desired cadence and cost.
- Replace the in-process WebSocket hub with a Vercel-compatible realtime service
  or another verified transport. Publish invalidations/events after commits;
  clients should rebuild authoritative snapshots from the database/API.
- Keep movement represented as persisted start/destination/arrival segments so
  clients interpolate animation without per-frame server writes.
- Test concurrent workers, retry after partial failure, stale lease recovery,
  disconnected users, and deployment/restart continuity.

### 5. Add Privy wallets and real funding

- Provision or associate exactly one Privy wallet with each authenticated user.
  Store only provider IDs, public addresses, and necessary metadata in Postgres.
- Keep signing/delegation authority server-side under Privy's supported policy.
  Never expose private keys, signing tokens, or unrestricted wallet actions to
  the browser, model context, logs, or database.
- Verify the supported Stripe Crypto Onramp path into the exact wallet, chain,
  and asset before building the balance UI. Display fiat value without implying
  that virtual budget accounting is an onchain balance.
- Define who authorizes autonomous MPP spend and how that authorization can be
  capped, paused, revoked, and audited. The model never controls payment policy.
- Retain atomic reservations before network calls and settle from verified
  payment receipts. Add idempotency so retries cannot double-pay.
- Keep the paid endpoint allowlist. Treat conversation, memory, and tool output
  as untrusted observations that cannot alter wallet policy or spend limits.
- Test onboarding, wallet failure/recovery, insufficient funds, concurrent
  spend, revoked authorization, receipt mismatch, and user deletion.

### 6. Deploy the web/API surfaces

- The first project is configured as a repository-root Vercel project in
  `vercel.json`: pnpm install, filtered Vite build, `apps/web/dist` output, and
  a production-only Cron invocation of `/api/jobs/run`. Add separate Vercel
  projects only if the API/realtime topology requires it.
- Deploy API handlers as Vercel Functions. Do not import `LocalRuntime` timers or
  the in-process WebSocket hub from a serverless function.
- Configure production API/realtime URLs without localhost fallbacks. Restrict
  CORS to known origins and apply appropriate cookie, CSRF, and security-header
  controls for the chosen session transport.
- Put secrets only in managed environment configuration. Keep `.env`, database
  files, wallet material, and generated output untracked.
- Add structured logs, error reporting, job/queue health, spend alerts, rate
  limits, and a server-side kill switch. Redact prompts, reasoning, tokens,
  secrets, and sensitive wallet/session data.
- Add a health/readiness path that checks required dependencies without spending
  money.

### 7. Validate and stage rollout

1. Run `pnpm check` in deterministic mode on every change.
2. Run Postgres/auth/job integration suites with no paid MPP calls.
3. Exercise two isolated authenticated users plus an anonymous spectator.
4. Verify cross-user mutations and all unauthenticated admin calls fail.
5. Verify characters continue through user disconnects, deploys, duplicate job
   delivery, and worker crashes without duplicate actions or payments.
6. Use a separate test wallet and the smallest explicit cap for the first paid
   end-to-end call. Paid tests require deliberate approval; never couple them to
   CI or ordinary preview deployments.
7. Start invite-only with conservative global caps and monitoring before opening
   character creation more broadly.

## Acceptance criteria for the hosted milestone

- A user authenticates, gets one durable account and wallet, creates one
  character, disconnects, and later returns to the same ownership state.
- Anonymous spectators can read only the intentionally public world surface.
- No user can mutate another user's character or call admin operations.
- State survives deployments; autonomous work runs through idempotent durable
  jobs rather than process-local timers.
- Concurrent workers cannot claim the same action or overspend any configured
  limit. Network retries cannot duplicate a payment.
- Wallet secrets and signing authority never reach client bundles, prompts,
  logs, or application tables.
- Funding, proposed/completed payments, failures, receipts, remaining onchain
  balance, and app-level budget are understandable and correctly distinguished.
- Deterministic CI is green, production dependencies are observable, and an
  operator can pause simulation and all spending immediately.

## Later product work

After the deterministic hosted gate is proven, add model-backed behavior through
OpenRouter with explicit model, token, timeout, and logging controls. Then add
one server-provisioned Privy wallet per user, Stripe Crypto Onramp funding into
the supported chain/asset, and MPP payments authorized by server-side policy.
Only after those integrations are safe should we expand into richer locations
and group interactions, construction and persistent world improvements,
reputation and an economy, third-party allowlisted paid tools, mobile layout,
moderation, private conversations, export/recovery policy, and multiple
characters per user.
