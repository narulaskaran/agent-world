# Agent World roadmap: local-first

This file is an executable plan. An agent with no prior context should be able
to read it top to bottom and complete every step. Read **How to work**,
**Locked decisions** and **Repo facts** first, then do the steps in order.

## Goal and end state

Agent World becomes a **local-first, self-hosted** project.

- People clone the repo, run `pnpm start`, and get their own world at
  `http://127.0.0.1:4310`. With no keys it runs deterministically at zero cost.
- **One optional key, `OPENROUTER_API_KEY`, powers all inference**: LLM dialogue
  and memories, and JEV decisions (JEV is served through OpenRouter's Decisions
  API, so users never juggle a second provider key).
- Alternatively, `pnpm wallet:setup` creates a local `mppx` wallet (key in the OS
  keychain) that the user funds with USDC. It pays per call for web search and
  avatars, and for LLM dialogue when no OpenRouter key is set (JEV decisions need
  the OpenRouter key). `pnpm install` provides `mppx`.
- World speed is a user setting (`AGENT_WORLD_DECISION_SCALE`).
- The public website is a **static marketing page** (`apps/site`): Three.js
  animation, a demo video, and a quickstart. No backend, no accounts, no
  functionality.
- The hosted stack (Vercel Functions, Neon, Neon Auth, QStash, wallet/payment) is
  removed from `main` and preserved on the `archive/hosted` branch. The project
  stops paying for hosting, a database, and LLM calls.

Why: Neon free-tier transfer was exhausted (see `docs/archive/neon-egress.md`).
The hosted stack carried nearly all of the cost and complexity, and the local
runtime (`apps/server` + SQLite) already exists.

## How to work

1. Work on branch `local-first` (created in Step 0). Do steps in order. Tick the
   box in **Progress** as each step's **Done when** checks pass, and commit that
   tick together with the step.
2. Commit once per step, message `Step N: <title>`. Never push, never open a PR,
   never force-anything, never rewrite history. Leave `archive/hosted` alone
   after Step 0.
3. `pnpm check` (typecheck + tests + build for every workspace) must pass at the
   end of every step. Run `pnpm install` first, and again whenever you change any
   `package.json`. Commit `pnpm-lock.yaml` with the change that caused it (CI
   uses `--frozen-lockfile`).
4. Run `pnpm exec prettier --write <files you touched>` before committing.
5. **Never spend money.** Tests and scripts must run offline with a fake
   `fetch`. Any child process you start for testing must have
   `OPENROUTER_API_KEY` and `AGENT_WORLD_LIVE_MPP` unset.
   Never put a key in a committed file, log line, snapshot, or error message.
   Never move funds, never run `mppx account export`, and never create a real
   wallet account on this machine while testing: inject a fake signer
   (`MppxRequester` accepts a `sign` function) or point `MPPX_BIN` at a stub.
6. Do not refactor beyond what a step asks. Leave `packages/shared` contracts
   alone unless a step says otherwise, and do not touch the MPP paid-tool logic
   in `apps/server/src/mppx.ts` (web search, avatars); it keeps working as today,
   off by default. The only allowed change there is binary resolution (Step 5b).
7. If a step is blocked (missing information, an external service you cannot
   reach), do **not** guess and do not stop the whole run. Write it under
   **Blockers** with what you tried, skip it, and continue with the next step.
8. Verify by running things. "It typechecks" is not "it works": Steps 3 and 10
   require starting the real server and hitting it.

## Locked decisions

Do not reopen these.

| Topic                | Decision                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users                | Single trusted local user. No auth, accounts, sessions, or per-user ownership.                                                                                                |
| Persistence          | Existing SQLite (`packages/db`, better-sqlite3, drizzle). No Postgres.                                                                                                        |
| Network exposure     | Server binds `127.0.0.1` by default (`AGENT_WORLD_HOST` overrides). Admin routes are unauthenticated, so they must not be exposed by default.                                 |
| Realtime             | Client uses the existing `/ws` WebSocket. No polling, no ETag.                                                                                                                |
| Keys                 | Environment variables only (`.env`, gitignored). No key storage in the database, no encryption, no key-management endpoints, no migrations.                                   |
| Decision precedence  | Scheduled decisions: JEV (if key) → OpenRouter LLM (if key) → deterministic. Directives/events: OpenRouter LLM (if key) → deterministic. JEV never writes text.               |
| One key              | `OPENROUTER_API_KEY` is the only inference key. There is no `TYPESAFE_JEV_API_KEY` and no direct TypeSafe API use.                                                            |
| Dialogue and memory  | OpenRouter LLM if `OPENROUTER_API_KEY`, else MPP if `AGENT_WORLD_LIVE_MPP=true`, else deterministic lines.                                                                    |
| JEV transport        | OpenRouter Decisions API only (`POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`). It is an alpha endpoint, so failures fall back to deterministic. |
| Cost bearer          | The user's own keys. Existing per-character and server-wide daily budget caps stay and are enforced for real spend.                                                           |
| Web search / avatars | Unchanged: MPP-only, off by default. Without MPP they fall back exactly as they do today.                                                                                     |
| Wallet and funding   | Local `mppx` account in the OS keychain, created by a setup script. Funded manually by the user with USDC on Tempo mainnet. No web wallet, Privy, or Stripe.                  |
| `mppx` install       | Regular dependency of `apps/server`, so `pnpm install` provides the CLI. `MPPX_BIN` still overrides. Paid tools stay off until the user runs the setup script.                |
| Landing page         | New static app `apps/site`, deployed on Vercel static. The interactive world UI is `apps/web`, served by the local server, not deployed publicly.                             |
| Desktop app          | Out of scope (later). Just keep the client talking only to the local API and `/ws`, with config outside the code.                                                             |

## Repo facts (verified against `main` at 537458e)

- pnpm workspace (`apps/*`, `packages/*`), Node 24, pnpm 10.30.3, TypeScript
  strict, ESM. `pnpm check` = `typecheck && test && build` across workspaces.
- `apps/server`: Fastify + `@fastify/websocket` + `@fastify/cors`.
  `src/server.ts` is one top-level script (no factory). `src/local-runtime.ts`
  runs `engine.runDueJobs()` and publishes a full snapshot over `/ws` every 1s.
  `src/world.ts` (`WorldEngine`) owns behaviour. `src/services.ts`
  (`PaidServices`) does decisions, dialogue, memory extraction, web search and
  avatars. `src/mppx.ts` is the MPP transport.
- `PaidServices.budgeted()` reserves cost, runs the call if `this.live`
  (`AGENT_WORLD_LIVE_MPP === "true"`), else records a small fake cost and returns
  the deterministic `fallback()`. `decide`, `conversationMessage`,
  `extractMemory` call `https://openrouter.mpp.tempo.xyz/v1/chat/completions`
  through the MPP transport. `web_search` uses Exa, `generateAvatar` uses OpenAI
  images, both via MPP.
- `WorldEngine.runScheduledDecision` calls `services.decide(buildContext(id))`
  with **no** `event` and **no** `directive`. Queue items (owner directives,
  `first_mission`, `new_character`, conversation turns) call `decide` with
  `event`/`directive` set. `applyDecision` handles `approach`/`start_conversation`
  (uses `targetCharacterId`), `move`/`inspect_location` (uses `locationId`),
  `web_search`, `sleep`, `idle`.
- Per-character `decisionIntervalSeconds` (schema min 30, max 900, default 60)
  sets `nextDecisionAt`. `AGENT_WORLD_DECISION_SCALE` appears in `.env.example`
  but is **not used anywhere in code**. Budgets: per-character
  `dailyBudgetMicros`, server-wide `AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS`
  (default 2,000,000 = $2), enforced in `runDueJobs` and `reserveCost`.
- Local routes today: `GET /health`, `GET /api/state` (bare snapshot),
  `POST /api/characters`, `PATCH|DELETE /api/characters/:name`,
  `POST /api/characters/:name/directives`, `POST /api/characters/:name/avatar`,
  `GET|PATCH /api/admin`, `POST /api/admin/pause`, `POST /api/admin/reset`,
  `GET /ws`. Local snapshot has `artifacts: []`. The local store has no
  artifacts, reports, mute, reputation or export/import.
- `apps/web` (React 19 + Three.js) has been reshaped for the hosted API: Neon
  Auth sign-in (`src/auth.ts`, `authClient` in `App.tsx`), a `{ snapshot,
viewer }` envelope, ETag polling (`src/poll.ts`), `@vercel/analytics`, and UI
  for reports, artifacts, export/restore, reputation and admin report/mute that
  the local server does not implement. `api.inspect` calls
  `GET /api/characters/:id`, which the local server lacks. Game code is in
  `src/game/` (hex board, camera, characters, landmarks, `world-scene.ts`).
- Only `api/index.ts` imports `packages/hosted`. `packages/db` depends on
  `drizzle-orm` + `better-sqlite3`, which **stay**.
- `mppx` is an npm package (wevm/mppx, v0.10.1 at time of writing, ~107 MB
  installed, no native build scripts). It installs an `mppx` binary. Verified commands: `mppx account create|list|view|default|delete|export|fund`
  (`--account <name>`, `--format json`), `mppx sign --challenge ... --account ...
--network mainnet --format json`. `account fund` only gives **testnet** tokens;
  our signer is mainnet-only (Tempo chain 4217, USDC), so mainnet funding is a
  manual transfer. Keys live in the OS keychain: macOS Keychain; on Linux it needs
  `secret-tool` (package `libsecret-tools`) and a running secret service, else the
  CLI errors with code `KEYCHAIN_UNAVAILABLE`. `MPPX_PRIVATE_KEY` (env) is an
  alternative the CLI supports; we do not automate it. `MppxRequester` defaults
  to binary `MPPX_BIN ?? "mppx"` and account `MPPX_ACCOUNT ?? "agent-world"`.
- **OpenRouter Decisions API** (alpha), verified from OpenRouter's own OpenAPI spec
  (`https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md`)
  and the quick start on the model page: `POST https://openrouter.ai/api/alpha/decisions`
  (the operation's server is `https://openrouter.ai`; it is **not** under
  `/api/v1`, and an unauthenticated probe returns 401 there while
  `/api/v1/decisions` returns 404). Header `Authorization: Bearer <key>`. Body:
  `{ model: "typesafe/jev-1.13", state: string|object|array, questions: { <name>:
Question } }`, plus optional `provider`, `session_id` (max 256), `user` (max
  256), `trace`. Questions: `{ type: "noul", instructions, criteria?: { true,
false } }`, `{ type: "choice", instructions, criteria: { <key>: <description> } }`,
  `{ type: "score", instructions, criteria: [<level>, ...] }`. 200 response: `{ id,
model: "typesafe/jev-1.13-<date>", provider: "TypeSafe", answers, usage: {
input_tokens, output_tokens, cost } }` where `cost` is USD (for example 476
  input tokens cost 0.000019992, which is $0.042 per million input tokens; output
  tokens are free). Answers: noul `{ type, noul }` (0-1); choice `{ type, choice,
confidence, probabilities }`; score `{ type, score, legend, confidence,
probabilities }`. Errors: 400, 401, 402 (insufficient credits), 403, 404, 413,
  429, 500, 502, 503, 524, 529, body `{ error: { code, message } }`. Context is 32k
  tokens for `state` plus the longest question.
- `packages/hosted/src/jev.ts` (+ `jev.test.ts`) is **uncommitted** work on
  `main`: a `TickDecider` that calls TypeSafe's direct API
  (`api.typesafe.ai/v1/systemone`, model `jev-latest`) with typed choice/noul
  questions, validates every answer against closed option sets, falls back on
  confidence < 0.4, invalid answers, a 4s timeout or errors, and pauses 60s after 2
  straight failures. Step 0 preserves it on `archive/hosted`; Step 6 ports it and
  moves it to the OpenRouter endpoint above. The request body shape is the same;
  the URL, key, model id and cost source change.
- `AGENTS.md` is the real file; `CLAUDE.md` and `CURSOR.md` are symlinks to it.
  Edit `AGENTS.md` only.

## Progress

- [x] 0 Preserve and branch (done by the planner)
- [x] 1 Remove the hosted stack
- [x] 2 Decouple the client from hosted (auth, viewer, polling) and add local routes
- [x] 3 Serve the client from the server; one-command run; smoke test
- [x] 4 Config, safe defaults and mode reporting
- [x] 5 OpenRouter client (chat for dialogue, memories and LLM decisions)
- [x] 5b Local wallet setup (`mppx` dependency and `pnpm wallet:setup`)
- [x] 6 JEV decision engine (OpenRouter Decisions API)
- [ ] 7 JEV live probe script (a human runs it)
- [ ] 8 World speed
- [ ] 9 Landing page (`apps/site`)
- [ ] 10 Docs, CI and cleanup
- [ ] 11 Final verification

## Steps

### Step 0: Preserve and branch (already done by the planner; verify only)

The planner already ran the preservation sequence and pushed both branches:
`archive/hosted` (the hosted stack plus the previously uncommitted JEV work) and
`local-first` (this roadmap; the branch you work on). Verify, do not redo:

- `git branch -a` shows `archive/hosted` and `local-first` locally and on
  `origin`, and `local-first` is checked out. On a fresh clone run
  `git fetch origin && git switch local-first`.
- `git show archive/hosted:packages/hosted/src/jev.ts` prints the file.
- `git status --short` shows nothing except an optional untracked `.claude/`.

If a branch is missing, or the status is anything else, do not improvise and do not
discard changes: add a **Blockers** entry and continue only if the missing piece
does not affect later steps (Step 6 needs `archive/hosted` for the JEV port).

Done when: the three checks above pass. Tick box 0 (already ticked) and go to
Step 1.

### Step 1: Remove the hosted stack

Delete: `packages/hosted/`, `api/`, `db/` (Postgres migrations). Move
`docs/neon-egress.md` and `docs/spike-paid.md` to `docs/archive/`. Do **not**
touch `vercel.json` yet (Step 9 rewrites it) or `apps/web` (Step 2).

Then `pnpm install` (updates the lockfile), and search for leftovers:
`grep -rn "hosted\|neondatabase\|@agent-world/hosted" --include=*.ts --include=*.tsx --include=*.json --include=*.yml .`
(ignoring `node_modules`, `docs/archive`, `ROADMAP.md`, and docs you rewrite in
Step 10). Fix any code reference. The web client's `@neondatabase/neon-js`
dependency stays until Step 2.

Done when: `pnpm check` passes; `ls packages` shows only `db shared`; no
`packages/hosted` or `api` directory exists.

### Step 2: Decouple the client from hosted; add local routes

Goal: `apps/web` talks only to the local server (REST + `/ws`) and needs no auth.

Client (`apps/web`):

- Delete `src/auth.ts`, `src/poll.ts`, `src/poll.test.ts`. Remove
  `@neondatabase/neon-js` and `@vercel/analytics` from `package.json`.
- `useWorld` in `App.tsx`: replace polling with a WebSocket hook (new
  `src/ws.ts`). URL = `API_URL` if set, else `location.origin`, with `http` →
  `ws`, path `/ws`. Messages are `ServerMessage` from `@agent-world/shared`
  (`snapshot` / `error`). Reconnect with exponential backoff (1s doubling to a
  30s cap, reset on a successful message). Export the backoff calculation as a
  pure function and unit-test it. Show the existing "connected" indicator from
  socket state.
- `api.ts`: remove ETag handling, the `{ snapshot, viewer }` envelope handling,
  `session`, `credentials: "include"`, and API functions for features the local
  store lacks (`report`, `leaveArtifact`, `exportCharacter`, `importCharacter`,
  `resolveReport`, `muteCharacter`). Keep `create`, `update`, `directive`,
  `avatar`, `remove`, `inspect`, `admin`, `pauseWorld`, `updateWorld`,
  `resetWorld`.
- `App.tsx`: remove the sign-in/sign-up modal, `signOut`, `useAuth`, `Analytics`,
  the invite-only and per-user character-cap gating, the report form, the
  leave-a-note form, Export and "Restore from export", the reputation label, and
  the admin modal's report/mute sections. The viewer is a constant local admin:
  every character is controllable and the admin panel (pause, budget, reset,
  costs) is always available.
- `src/public-record.ts` (+ test): drop the guest redaction path; the local user
  sees full event detail. Keep the feed's length limit and summary shortening.
- Update `src/api.test.ts` and other tests to match. Keep `src/game/*` untouched.

Server (`apps/server`):

- Extract the Fastify setup from `src/server.ts` into
  `src/app.ts: createApp({ runtime, repository, ... })` returning the Fastify
  instance (not listening). `server.ts` becomes: read env, build repository and
  runtime, `createApp`, listen. This enables `app.inject` tests.
- Add `GET /api/characters/:idOrName` returning `{ character: CharacterInspect }`
  built from the store's public character (personality, model, budgets,
  `decisionIntervalSeconds`, memories, relationships; `reputation: 0`;
  `locationId` as the snapshot has it). 404 if missing.
- Add `src/app.test.ts` covering: `/health`, create → `/api/state` shows it,
  inspect route (200 and 404), validation error (400), duplicate name (409).

Done when: `pnpm check` passes;
`grep -rniE "neon|authClient|useAuth|@vercel/analytics|etag|if-none-match|/api/auth|guestEventDetail" apps/web/src`
prints nothing; `apps/web/package.json` has neither removed dependency.

### Step 3: Serve the client from the server; one-command run; smoke test

- Add `@fastify/static` to `apps/server`. In `createApp`, if the built web client
  exists (`apps/web/dist`, resolved relative to the server source), serve it at
  `/` with an SPA fallback to `index.html` for any non-`/api`, non-`/ws`,
  non-`/health` GET. If it does not exist, `/` returns a short plain-text hint to
  run `pnpm start`.
- `apps/server/package.json`: move `tsx` to `dependencies`;
  `"start": "tsx --env-file-if-exists=../../.env src/server.ts"` (workspace
  packages export TypeScript source, so running compiled `dist/` with plain node
  does not work). Keep `dev` and `build` working.
- Root `package.json`: add
  `"start": "pnpm --filter @agent-world/web build && pnpm --filter @agent-world/server start"`,
  `"smoke": "node scripts/smoke.mjs"`, and `"engines": { "node": ">=24" }`.
- Web client production API base is same-origin (`API_URL` empty). `pnpm dev`
  (server 4310 + Vite 4311) must keep working.
- Server host/port/CORS: listen on `AGENT_WORLD_HOST` (default `127.0.0.1`) and
  `AGENT_WORLD_SERVER_PORT` (default `4310`). CORS allows only
  `AGENT_WORLD_WEB_ORIGIN` (default `http://localhost:4311`, the Vite dev
  origin).
- `scripts/smoke.mjs` (plain Node 24, no dependencies): spawns the server
  (`pnpm --filter @agent-world/server start`) on port `4319` with a temp
  `AGENT_WORLD_DATABASE`, keys unset, waits for `/health`; then asserts (1) `GET /`
  returns HTML, (2) `POST /api/characters` creates a character (use a valid
  body per `CreateCharacterSchema`), (3) a WebSocket client (Node's global
  `WebSocket`) on `/ws` receives a `snapshot` containing that character within
  5s, (4) `GET /api/characters/<name>` returns it, (5) after ~8s the character's
  `intent` or position has changed from creation. It exits non-zero on any
  failure and always kills the child and removes the temp directory.

Done when: `pnpm check` passes and `pnpm build && pnpm smoke` prints a pass line
for each assertion and exits 0. Run `pnpm smoke` yourself; do not assume it works.

### Step 4: Config, safe defaults and mode reporting

- Rewrite `.env.example` to only what local mode uses, each with a one-line
  comment: `AGENT_WORLD_HOST`, `AGENT_WORLD_SERVER_PORT`,
  `AGENT_WORLD_DATABASE`, `AGENT_WORLD_WEB_ORIGIN` (dev only), `VITE_API_URL`
  (dev only, optional), `AGENT_WORLD_DECISION_SCALE`,
  `AGENT_WORLD_REACTION_COOLDOWN_MS`, `AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS`,
  `OPENROUTER_API_KEY` (the only inference key), `AGENT_WORLD_JEV_DECISIONS`,
  `AGENT_WORLD_JEV_MODEL` (optional, default `typesafe/jev-1.13`),
  `AGENT_WORLD_LIVE_MPP` (+ `MPPX_BIN`, `MPPX_ACCOUNT`), `LOG_LEVEL`. Remove
  everything Neon, Vercel, cron, Privy, invite, mutation-limit or QStash related.
  Keys default empty.
- New `apps/server/src/config.ts`: `loadConfig(env)` returning a typed object
  (host, port, database path, scale, budgets, key presence as booleans plus the
  key values kept private to their transports) and
  `describeMode(config)` returning
  `{ decisions: "jev" | "openrouter" | "deterministic", dialogue: "openrouter" | "mpp" | "deterministic", paidTools: boolean, decisionScale: number, serverDailyBudgetMicros: number }`.
  Unit-test both, including that no key value appears in `describeMode` output.
- On boot, log one line with the mode and the listen URL. Add `mode` (from
  `describeMode`) to `GET /health`. Never log or return key values.

Done when: `pnpm check` passes; a test proves `/health` never contains the key
strings when keys are set in the test env (use fake dummy values like
`sk-test-not-real`).

### Step 5: OpenRouter client

Goal: with `OPENROUTER_API_KEY` set, `decide`, `conversationMessage` and
`extractMemory` call OpenRouter directly with the user's key. Build this as a small
`OpenRouterClient` (key, base URL, injected `fetch`, timeout, shared error mapping)
that exposes `chat(body)` now; Step 6 adds `decisions(body)` to the same client so
both endpoints share one key, one error mapping, and one auth-failure breaker.

- New `apps/server/src/openrouter.ts`: `OpenRouterTransport` implementing the
  same `requestJson(url, body, maxSpendMicros)` shape as `MppTransport` (add a
  neutral alias like `JsonTransport` in `services.ts` rather than reusing the
  MPP name for it). It POSTs to `https://openrouter.ai/api/v1/chat/completions`
  (ignore the URL argument's host; the LLM methods keep passing the same
  paths), with `Authorization: Bearer <key>`, `Content-Type: application/json`,
  optional `HTTP-Referer` and `X-Title: Agent World`, a 30s
  `AbortSignal.timeout`, and returns `{ body, metadata: { transport:
"openrouter" }, amountMicros }`, where `amountMicros` is
  `Math.round(usage.cost * 1_000_000)` from the response when `usage.cost` is a
  finite number, else `null` (the existing `budgeted` code then settles at the
  reserved maximum). Before relying on `usage.cost`, check OpenRouter's current
  docs if you can reach them; if not, the `null` fallback keeps spend safe.
- Errors: non-2xx throws `Error("OpenRouter <status>: <first 200 chars of the
API error message>")`. The key must never appear in a message, metadata or
  log. Auth-class failures (401, 402, 403) pause **all** OpenRouter calls for 60s
  (a bad key or empty balance affects every endpoint). After 2 consecutive
  other failures on an endpoint, skip that endpoint for 60s (throw a clear
  "OpenRouter paused after repeated failures" error so callers fall through to
  `handleAgentError`, which already keeps the world running).
- `PaidServices`: replace the single `live` flag with per-capability liveness.
  `budgeted()` takes `live: boolean` per call. LLM methods are live when an LLM
  transport exists: OpenRouter if the key is set, else the MPP transport when
  `AGENT_WORLD_LIVE_MPP=true`, else none. `webSearch`/`generateAvatar` stay live
  only under MPP. When a call is not live it behaves exactly as today
  (deterministic fallback, small fake cost recorded).
- Build the services from config in one place (`createServices(repository,
config)`) and pass them through `LocalRuntime` to `WorldEngine` (both currently
  construct their own defaults; add an optional parameter).
- Update `MODEL_OPTIONS` only if a listed slug is not a valid OpenRouter model id
  (check `https://openrouter.ai/api/v1/models` if reachable; otherwise leave it and
  add a Blockers note).
- Tests (fake `fetch`, offline): success path returns the message and settles
  the parsed cost; missing `usage.cost` settles at the reserved max; a 401/402/429
  produces a thrown error and releases/settles the reservation; the key never
  appears in error text; with no key the deterministic fallback runs and `fetch`
  is never called; the breaker pauses after 2 failures.

Done when: `pnpm check` passes and all the above tests exist and pass.

### Step 5b: Local wallet setup (`mppx` dependency and `pnpm wallet:setup`)

Goal: a user can enable pay-as-you-go paid tools (LLM via the MPP gateway, web
search, avatars) without a web wallet. Custody is a local `mppx` account in their
OS keychain; funding is a manual USDC transfer they make themselves.

- Add `mppx` as a regular dependency of `apps/server` (pin the version that is
  current when you run `pnpm add`; it is about 107 MB installed, so mention that
  in the README). `pnpm install` must then provide the `mppx` binary. If pnpm
  reports its dependency build scripts as ignored, do not enable any; `mppx`
  needs none.
- In `apps/server/src/mppx.ts` change only how the default binary is resolved:
  `options.binary ?? process.env.MPPX_BIN ?? <bundled binary>`, where the bundled
  binary is the `mppx` bin shipped in `apps/server/node_modules/.bin/mppx` when it
  exists (resolve it without relying on `PATH`), else `"mppx"`. Unit-test the
  resolution order (option, env, bundled, bare name) with a fake filesystem
  lookup or injected resolver.
- New `scripts/wallet-setup.mjs` (plain Node 24, no dependencies), exposed as
  root script `"wallet:setup": "node scripts/wallet-setup.mjs"` (do **not** name
  it `setup`; that is a built-in pnpm command). Behaviour:
  1. Find the binary the same way the server does. Flags: `--dry-run` (print
     what it would do, run nothing that writes), `--check` (verify the binary
     runs with `mppx --help`, exit 0/1, no keychain access, no network),
     `--account <name>` (default `MPPX_ACCOUNT` or `agent-world`).
  2. Run `mppx account list --format json`. If it fails with code
     `KEYCHAIN_UNAVAILABLE`, print OS-specific guidance and exit non-zero without
     creating anything: on Linux install `libsecret-tools` and make sure a secret
     service (for example gnome-keyring) is running; macOS and Windows use the
     built-in store. Mention that `MPPX_PRIVATE_KEY` exists but is not automated
     and not recommended.
  3. If the account does not exist, ask (y/N, default no) before running
     `mppx account create --account <name>`.
  4. Run `mppx account view --account <name> --format json` and print the public
     address only.
  5. Print funding instructions: send a small amount of **USDC on Tempo mainnet**
     to that address (suggest $1 to $5), note that `mppx account fund` gives
     testnet tokens only and does not work for this project's mainnet signer, and
     restate the spend caps (server default $2/day, per-character budgets).
  6. Ask (y/N) before enabling paid tools. If yes, create `.env` from
     `.env.example` when missing, and set only `AGENT_WORLD_LIVE_MPP=true` and
     `MPPX_ACCOUNT=<name>` in it, preserving every other line.
  7. Never print, log, write or export a private key. Never call
     `mppx account export`. Never initiate a transfer.
- Test the script's logic offline: split the decision logic into an importable
  module (`scripts/lib/wallet-setup.mjs` or similar) and unit-test it with a stub
  binary (a tiny executable script that prints canned JSON, including a
  `KEYCHAIN_UNAVAILABLE` case and an "account already exists" case). Tests must
  not touch the real keychain or network. Wire this test into `pnpm check` (for
  example a `test` script in the root or a small `scripts` workspace).
- `describeMode` (Step 4) reports `paidTools: true` only when
  `AGENT_WORLD_LIVE_MPP=true`; the boot log should hint `run pnpm wallet:setup`
  when it is false and no OpenRouter key is set.

Done when: `pnpm check` passes; `pnpm install` yields a working binary
(`pnpm --filter @agent-world/server exec mppx --help` exits 0);
`pnpm wallet:setup --check` exits 0; `pnpm wallet:setup --dry-run` prints its
plan without touching the keychain, `.env`, or the network; the stub-binary tests
cover keychain-unavailable, existing account, new account (after confirmation),
and `.env` editing that preserves unrelated lines.

### Step 6: JEV decision engine (OpenRouter Decisions API)

Port the hosted JEV decider to the local engine, on OpenRouter. Start from
`git show archive/hosted:packages/hosted/src/jev.ts` and `jev.test.ts`. The
request and response shapes are in **Repo facts** and were checked against
OpenRouter's spec; if the port disagrees, the spec wins. The hosted version used
TypeSafe's direct API; the differences here are only the URL
(`https://openrouter.ai/api/alpha/decisions`), the key (`OPENROUTER_API_KEY`),
the model id (`typesafe/jev-1.13`, overridable with `AGENT_WORLD_JEV_MODEL`), and
the cost source (`usage.cost`). The endpoint is alpha: keep the response parsing
strict, and treat any unexpected shape as a failure (return `null`).

- Add `decisions(body)` to `OpenRouterClient` (Step 5): POST to the URL above with
  `Authorization: Bearer <key>` and `Content-Type: application/json`, a 4s
  timeout (JEV answers are fast; a slow one is a failure), the same error mapping
  (`Error("OpenRouter <status>: <first 200 chars of error.message>")`, never the
  key), and the shared auth-failure breaker.
- New `apps/server/src/jev.ts`. Keep the closed-option validation,
  `MIN_ACTION_CONFIDENCE = 0.4`, and a JEV-specific circuit breaker (2 straight
  failures → 60s pause, time injected for tests). `OpenRouterClient` is injected,
  so tests use a fake `fetch` and never touch the network.
- Input is the local `AgentContext` (extend it with an optional
  `relationships: Array<{ name: string; impression: string; affinity: number }>`
  filled in `buildContext` from the character's public relationships). Build the
  `state` object from it (character, people nearby, places with occupancy,
  recent memories, relationship words), never including private conversation
  lines.
- Questions and mapping to the local `AgentDecision`:
  - `action` choice: `talk` (only if someone is available), `inspect`, `walk`.
    (Drop hosted's `note` and `group`: the local world has no artifacts and only
    two-person conversations.)
  - `partner` choice over `context.nearby` (up to 6 nearest whose `state` is not
    `talking`, `sleeping`, or `paused`), keyed by name, mapped back to id.
  - `walk_to` / `inspect_what` choice over `WORLD_LOCATIONS` (from
    `@agent-world/shared`), excluding the current area for `walk_to`.
  - Result mapping: talk → `{ action: "approach", targetCharacterId, intent:
"Ask <name> what they have noticed around <area name>" }`; walk →
    `{ action: "move", locationId, intent: "Exploring <location name>" }`; inspect
    → `{ action: "inspect_location", locationId, intent: "Looking around <location
name>" }`. Intent strings are templated from validated ids; JEV output is never
    used as free text.
  - Any failure, timeout, invalid or low-confidence answer, unexpected response
    shape, or open breaker → return `null` so the caller falls through.
- Integrate in `PaidServices.decide`: only when `context.event` and
  `context.directive` are both undefined (a scheduled decision) and JEV is
  enabled, call JEV through `budgeted()` with `category: "inference"`,
  `provider: "openrouter-jev"`, `countAgainstCharacter: true`, and a reservation of
  300 micros. Settle at `max(1, ceil(usage.cost * 1_000_000))` micros; if
  `usage.cost` is missing use `ceil(usage.input_tokens * 0.042)`; if `usage` is
  missing use `ceil(JSON.stringify(body).length / 4 * 0.042)`. If JEV returns
  `null`, continue to the OpenRouter LLM decision, then the deterministic
  fallback. Directive/event decisions never use JEV.
- JEV is enabled when `OPENROUTER_API_KEY` is set and `AGENT_WORLD_JEV_DECISIONS`
  is not `"false"`. `describeMode.decisions` is `"jev"` when enabled, `"openrouter"`
  when there is a key but JEV is disabled, else `"deterministic"`.
- Tests (fake `fetch`, offline): the request goes to the exact URL with the Bearer
  header and a body containing `model`, `state`, `questions` (and no
  `messages`); each mapping above; low confidence → falls through; a choice not in
  the option set → falls through; malformed or unexpected response → falls
  through; HTTP 402/429/5xx and timeout → fall through, and the breaker trips after
  2 and then does not call `fetch` for 60s (fake clock); disabled by
  `AGENT_WORLD_JEV_DECISIONS=false`; no key → `fetch` never called; a directive or
  event context never calls JEV; the request body contains no private conversation
  text; the ledger settles exactly `usage.cost` and records provider
  `openrouter-jev`; the key never appears in any error or log text.

Done when: `pnpm check` passes with the tests above.

### Step 7: JEV live probe script (a human runs it)

Because the Decisions endpoint is alpha, give the owner a one-command way to
confirm it works with a real key. An agent must **not** run it (it needs a key and
costs about $0.00002).

- Add `scripts/jev-probe.mjs` and root script `"jev:probe": "node scripts/jev-probe.mjs"`.
  Put the logic in an importable module with an injectable `fetch` so it is
  testable offline. It reads `OPENROUTER_API_KEY` from the environment (loading
  `.env` if present), refuses to run without it, sends one tiny `noul` question
  to the endpoint used by Step 6, and prints the resolved model, the answer, the
  latency, and `usage.cost`. Exit code is non-zero on any failure or unexpected
  shape. `--dry-run` prints the exact request (with the key redacted) and sends
  nothing.
- Tests use a fake `fetch`: success, HTTP 401, malformed body, and that the key is
  never printed.

Done when: `pnpm check` passes and `pnpm jev:probe --dry-run` prints the request
without a key and without network access.

### Step 8: World speed

- Implement `AGENT_WORLD_DECISION_SCALE` (float, default `1`, clamp to
  `0.1`–`60`, invalid → `1` with a boot warning). Effective interval =
  `decisionIntervalSeconds * 1000 / scale`. Apply it at every place `nextDecisionAt`
  is computed in `world.ts` (character creation, `runScheduledDecision`,
  `handleQueueItem`). Put the math in one small pure helper and unit-test it.
- Ticks must not overlap per character: confirm the existing `claimCharacter`
  lease covers a slow LLM/JEV call (it does today; add a test that a second
  `runDueJobs` while a decision is in flight does not start another for the same
  character).
- Surface spend: `describeMode` already reports the scale and server budget.
  When the scale is above `1` and any key is set, log one boot warning that spend
  scales with speed and point at the budget cap variable.

Done when: `pnpm check` passes, the helper and lease tests exist, and
`AGENT_WORLD_DECISION_SCALE=30 pnpm smoke` (deterministic) shows visible
movement well inside the smoke test's window.

### Step 9: Landing page (`apps/site`)

A marketing page only: **no functionality**, no backend calls, no accounts, no
forms, no analytics, no cookies.

- New workspace `apps/site` (`@agent-world/site`): Vite + TypeScript, vanilla
  (no React), `three` (named imports only). Scripts: `dev`, `build`
  (`tsc --noEmit && vite build`), `typecheck`, `test` (`vitest run
--passWithNoTests`). Root `pnpm check` must build it.
- Page sections, in order: hero (headline, one-line pitch, "Get it on GitHub" →
  `https://github.com/narulaskaran/agent-world`, and a "Quickstart" anchor);
  demo video; "How it works" (three short cards: create characters; they live on
  their own, moving, meeting, talking and remembering; you steer with directives
  and budgets); "Bring your own keys" (one OpenRouter key powers dialogue, memories and JEV decisions, or a local
  pay-as-you-go wallet via `pnpm wallet:setup`; spend caps; works with no keys at
  all); quickstart code block; footer. Copy must be factual to this repo. Do
  not promise a hosted world.
- Quickstart block:
  ```
  git clone https://github.com/narulaskaran/agent-world
  cd agent-world
  pnpm install
  cp .env.example .env   # optional: add keys
  pnpm start             # http://127.0.0.1:4310
  ```
  with a note: needs Node 24 and pnpm 10.
- Three.js hero animation: a low-poly hex-tile diorama built from an
  `InstancedMesh`, about 6 small colored characters wandering between tiles,
  soft directional + ambient light, a slow camera drift with pointer parallax,
  warm cream background matching the app (`#f4eddb`). Requirements: cap device
  pixel ratio at 2; pause rendering when the tab is hidden or the canvas is
  offscreen (`visibilitychange`, `IntersectionObserver`); under
  `prefers-reduced-motion` render one static frame; if WebGL is unavailable show a
  CSS gradient fallback; handle resize; canvas is `aria-hidden`. You may reuse
  ideas or copy small helpers from `apps/web/src/game/hex.ts`, but `apps/site`
  must not import from `apps/web`.
- Demo video: a `<video controls muted loop playsinline preload="metadata"
poster="/demo-poster.svg">` with `<source src="/demo.mp4" type="video/mp4">`.
  The real recording is a human task. Ship a generated `public/demo-poster.svg`
  placeholder, and on the source's `error` event hide the player and show the
  poster with the text "Demo video coming soon". Nothing may break if
  `demo.mp4` is absent.
- Quality bar: semantic headings and landmarks, visible focus styles, AA text
  contrast, responsive down to 360px wide, `<title>`, meta description and Open
  Graph title/description, total transferred size for the initial load
  (excluding the video) under 600 KB. Add a small unit test for any pure helper
  (for example the reduced-motion or hex-layout helper).
- Rewrite `vercel.json` for the static site only:
  `{ "$schema": "https://openapi.vercel.sh/vercel.json", "installCommand": "pnpm install --frozen-lockfile", "buildCommand": "pnpm --filter @agent-world/site build", "outputDirectory": "apps/site/dist" }`
  with no `framework` override needed, no rewrites, no crons, no functions.

Done when: `pnpm check` passes; `pnpm --filter @agent-world/site build` output
size is within budget; you started `pnpm --filter @agent-world/site dev`, fetched
`/` and confirmed the HTML contains the hero, quickstart and video sections; if a
browser tool is available, screenshot desktop and 375px widths and confirm the
canvas renders and the layout does not overflow.

### Step 10: Docs, CI and cleanup

- Rewrite `README.md`: what it is, a screenshot-free description, the quickstart,
  a config table (every var in `.env.example`), a "Costs and safety" section (JEV decisions run on OpenRouter's alpha Decisions API and fall back to deterministic decisions if it fails; runs
  free with no keys; with keys, spend is capped by the per-character and
  server-wide budgets; default server cap $2/day; localhost-only by default, admin
  routes are unauthenticated so do not expose the port), a "Speed" note
  (`AGENT_WORLD_DECISION_SCALE`), a "Wallet (optional)" section (`pnpm
wallet:setup`; the key stays in your OS keychain and no script exports or moves
  it; you fund the printed address yourself with a small amount of USDC on Tempo
  mainnet; `mppx` adds about 107 MB to the install; Linux needs `libsecret-tools`
  and a running secret service), and a link to `docs/archive` and the
  `archive/hosted` branch for the old hosted version.
- Rewrite `AGENTS.md` (the real file; `CLAUDE.md`/`CURSOR.md` are symlinks):
  layout now (`apps/site`, `apps/web`, `apps/server`, `packages/shared`,
  `packages/db`), local-first behaviour, the decision precedence, env-only keys,
  commands (`pnpm install`, `pnpm check`, `pnpm start`, `pnpm dev`, `pnpm smoke`).
  Remove all hosted, Neon, cron, QStash, JEV-hosted and "do not enable
  OpenRouter" text.
- Replace `HANDOFF.md` with a short current-state note (what shipped, how to run,
  how to archive/restore the hosted version, what is still open).
- `.github/workflows/check.yml`: keep checkout, pnpm, Node 24, install and
  `pnpm check`; delete the Neon resolution step and its header comment. Keep the
  `github.repository` guard. `.github/dependabot.yml`: rename the
  `neon-and-drizzle` group to `drizzle` and drop the `@neondatabase/*` pattern.
  `.github/workflows/dependabot-auto-merge.yml`: drop the
  `neondatabase` exclusion, keep the drizzle one.
- Remove the tracked QStash agent skills: `.agents/skills/upstash-qstash-js`,
  `.agents/skills/upstash-workflow-js`, and their two entries in
  `skills-lock.json` (delete the file if it ends up empty). Nothing else lives in
  `.agents/skills`.
- Final leftovers sweep: no reference to Neon, Vercel Functions, QStash, Privy,
  Stripe, `packages/hosted` or `db/migrations` outside `docs/archive`,
  `ROADMAP.md` (this file) and `HANDOFF.md`'s archive note.

Done when: `pnpm check` passes;
`grep -rniE "neon|qstash|privy|stripe|packages/hosted|api/index" --exclude-dir=node_modules --exclude-dir=docs --exclude-dir=.git --exclude-dir=.claude --exclude=pnpm-lock.yaml --exclude=ROADMAP.md --exclude=HANDOFF.md .`
prints nothing.

### Step 11: Final verification

Run all of these and record the result in your final message.

1. `rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install --frozen-lockfile && pnpm check`
2. `pnpm build && pnpm smoke && pnpm wallet:setup --check`
3. `git status --short` is clean (except `.claude/`); `git log --oneline main..local-first` shows one commit per step.
4. `git diff --stat main local-first -- packages/shared` is empty (contracts untouched).
5. Every **Progress** box is ticked; anything you skipped is marked
   "skipped" with a **Blockers** entry saying why.
6. With dummy keys and a fake `fetch` in tests only: prove no code path logs or
   returns a key (the tests from Steps 4, 5, 6 and 7 cover this; re-run them by name), and
   `grep -rn "TYPESAFE_JEV_API_KEY\|api.typesafe.ai" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude=ROADMAP.md .` prints nothing.

## Human-only tasks (an agent must not do these)

- **Stop hosted spend now** (independent of the code work): pause or delete the
  Upstash QStash schedule `scd_7Bh9SNqWXfhxev2WiSYTGQ5CwNxb`; remove the Vercel
  cron; pause or delete the Neon project **after** `archive/hosted` is pushed.
- Push `archive/hosted` and `local-first` to GitHub and open the PR.
- Try `pnpm wallet:setup` yourself on a real machine, fund the wallet with a
  small amount of USDC on Tempo mainnet, and run one paid-tools session. Agents
  must never create a real wallet, move funds, or handle private keys.
- In Vercel: disconnect the Neon and Upstash integrations, remove their env
  vars, confirm the project now builds `apps/site`, and keep the
  `agent.narula.xyz` domain pointed at it.
- Record the demo video from `pnpm start` (a few characters, a fast
  `AGENT_WORLD_DECISION_SCALE`, 20–40s, 1080p, H.264, under 8 MB) and save it as
  `apps/site/public/demo.mp4`.
- Run `pnpm jev:probe` once with your real `OPENROUTER_API_KEY` to confirm the
  alpha Decisions endpoint works for your account (costs about $0.00002).
- Close obsolete GitHub issues (#4 Privy, #5 Stripe/MPP funding) and update #3
  (OpenRouter) to point at this work.

## Later (not part of this plan)

- macOS app (Tauri or Electron around the local server and client; key in the
  Keychain; settings screen).
- Richer locations, group conversations, world-persistence improvements.
- A shared public world is out of scope; it would mean rebuilding the hosted
  stack from `archive/hosted`.

## Blockers

_(agents: record anything skipped or unresolved here, with what you tried)_
