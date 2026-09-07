# Spike: OpenRouter, Privy, Stripe Onramp + MPP

**Status:** research only. Do not implement or enable paid/model paths from this document.
**Purpose:** what is required to ship GitHub issues [#3](https://github.com/narulaskaran/agent-world/issues/3), [#4](https://github.com/narulaskaran/agent-world/issues/4), and [#5](https://github.com/narulaskaran/agent-world/issues/5). Vendor docs re-checked 2026-09-07; this is not a ROADMAP snapshot.

Production today is deterministic hosted mode (`packages/hosted`). Local `PaidServices` still exist behind `AGENT_WORLD_LIVE_MPP`, but hosted jobs never call them.

---

## Shared gates

Keep CI, ordinary Preview, and default Production deterministic. Live keys belong in Vercel **Production only** (sensitive), never in GitHub Actions, never `VITE_*`.

| Gate | Default | Meaning |
| --- | --- | --- |
| `AGENT_WORLD_LIVE_MODELS` | unset / `false` | OpenRouter HTTP calls. Proposed; do not reuse `LIVE_MPP`. |
| `AGENT_WORLD_LIVE_MPP` | `false` (already) | Onchain MPP 402 payments. |
| `AGENT_WORLD_LIVE_ONRAMP` | unset / `false` | Stripe Crypto Onramp session creation. |
| `simulation_paused` | existing admin pause | Stops hosted jobs; **not** a spend kill switch today. |
| Proposed spend-paused bit | off | Runtime/DB flag (not Vercel env) so operators can halt model + onramp + MPP **without redeploy**. |

**CI / Preview:** flags false, secrets absent, tests use deterministic fallbacks and in-memory/SQLite/Neon-without-spend. Do not set live keys on Preview “to try it.” First live calls need a dedicated Production (or explicitly approved) wallet, smallest cap, and human approval ([ROADMAP.md](../ROADMAP.md) §7.6).

**Fail closed:** flag off ⇒ deterministic, no vendor call. Flag on + missing secret or failed allowlist check ⇒ **hard fail** (no network spend, no “looks live” fallback). Never spend because a secret was empty.

**Kill switch:** `simulation_paused` stops jobs only. QA requires pausing simulation **and** all spending **without redeploy**. That needs a runtime flag read on every paid/model/onramp call (DB column or equivalent), not Vercel env + redeploy.

Existing `redact()` covers cookie/authorization/secret/token/key/email. Extend it for prompts, completions, wallet secrets, onramp client secrets, and MPP credentials before any live path.

---

## QA locked risk checklist

QA owns the full checklist. This spike maps each locked item to #3 / #4 / #5: **satisfies** (current hosted code or the issue’s required design) vs **open** (must be true at implement; not true today, or a human decision remains).

| # | Locked item | #3 OpenRouter | #4 Privy | #5 Onramp + MPP |
| --- | --- | --- | --- | --- |
| 1 | CI / previews stay deterministic — no live OpenRouter, Privy spend, or Stripe Onramp in `pnpm check` or preview deploys | **Satisfies today:** hosted jobs never call OpenRouter; `.github/workflows/check.yml` has no model secrets. **Implement must keep:** `AGENT_WORLD_LIVE_MODELS` unset in CI and ordinary Preview; no `OPENROUTER_API_KEY` there. | **Satisfies today:** no Privy client/server in repo. **Implement must keep:** no live `wallets().create` in `pnpm check` or Preview; mock only. #4 is provisioning, not spend — still no live Privy in CI/Preview. | **Satisfies today:** hosted never signs 402s or creates onramp sessions; local live path is `AGENT_WORLD_LIVE_MPP=false` in tests. **Implement must keep:** both live flags off in CI/Preview; no Stripe/MPP secrets on those envs. |
| 2 | Paid / model calls require explicit env flags + server allowlist; missing secrets = hard fail closed, not silent spend | **Open at implement.** Design: `AGENT_WORLD_LIVE_MODELS=true` **and** key present **and** model ∈ `MODEL_OPTIONS`. Flag off ⇒ deterministic (not spend). Flag on + missing key ⇒ hard fail, do **not** fall through to a fake “live” success. Local `PaidServices` today falls back whenever `LIVE_MPP` is false; hosted must not treat a missing OpenRouter key as a successful model tick. | **Open at implement.** Provisioning needs an explicit live-wallet gate (or Production-only). Missing `PRIVY_APP_SECRET` / signer key ⇒ fail closed, no wallet row that looks real. No browser allowlist of wallet actions — there should be **no** public signing API. | **Open at implement.** Independent flags `AGENT_WORLD_LIVE_ONRAMP` / `AGENT_WORLD_LIVE_MPP` plus server endpoint allowlist (Tempo USDC charge only; hosts enumerated in code). Missing Stripe or signer secrets ⇒ hard fail, never a 402 sign or onramp session. Local `budgeted()` fake-spend when live is false is the **deterministic** path, not a missing-secret live path. |
| 3 | Wallet keys / signing / LLM tokens never reach the browser, prompts, logs, or DB rows | **Open at implement** (policy is in the issue). Server-only key; log usage/latency/model id only. Do not persist prompts, completions, reasoning, or `OPENROUTER_API_KEY`. Today’s `redact()` does not cover prompt/completion bodies. | **Open at implement.** Store provider ids + public address only. Never persist `PRIVY_APP_SECRET`, authorization private keys, or signing JWTs. Public address may be shown to the owner; not in model context. | **Open at implement.** `STRIPE_SECRET_KEY` / webhook secret / MPP credentials / `Payment` authorization headers never in client, prompts, logs, or `cost_entries.metadata` beyond receipt ids. Onramp `client_secret` is session-scoped to the owner’s browser widget only — not logged, not in DB. |
| 4 | Auth boundaries: spectator read-only; owner can’t mutate another user’s character; admin gated by allowlist | **Satisfies today** for hosted HTTP: public reads; mutations use Neon session `owner_id`; admin is `AGENT_WORLD_ADMIN_USER_IDS`. **Implement must not regress:** model calls run as server jobs for an **owned** character, not a client-supplied id. Model output cannot grant admin or cross-user mutate. | **Satisfies today** for characters; **open for wallet routes.** Provision/read wallet only for `sessionUserId`; unique one wallet per Neon user. Spectators see no signing surface. Admin allowlist unchanged — admin is not unrestricted wallet control unless explicitly designed. | **Open at implement** for money routes. Onramp session and MPP spend must use the authenticated owner’s Privy address only (never client-supplied). Cross-user character mutate stays forbidden; paying a tool must not become a mutate. Admin budget/pause stay allowlisted (`/admin/*`). |
| 5 | Atomic spend caps + kill switch: pause simulation **and** all spending without redeploy; retries don’t double-pay | **Partial / open.** Local SQLite `reserveCost` caps inference micros; hosted `HostedStore` **lists** `cost_entries` but cannot reserve. Kill switch: `simulation_paused` stops jobs (including future model ticks) **without redeploy**, but does **not** stop a live HTTP call already in flight, and env flags require redeploy. Need a runtime spend-pause bit read before every OpenRouter call. Idempotency: one reservation per job attempt; no double charge to virtual budget on retry. OpenRouter API-key path has no onchain double-pay, but virtual ledger still must not double-count. | **Open.** #4 should not spend. Kill switch must also block **new wallet provisioning** and any later signer use. No atomic payment yet; unique `(owner_id)` prevents two wallets. Server signer + Privy policy are the future spend brake; they are not a sim-pause. | **Partial / open.** Local `budgeted()` is atomic reserve → call → settle/release; retries can still double-pay **onchain** if a 402 was signed and the job retries without recording challenge/receipt ids — hosted must persist idempotency keys. Caps: per-action / per-character / global exist as **virtual** fields; hosted reservation API missing. Kill switch **without redeploy** is **not** implemented for spend: add `world_state` spend-paused (or equivalent) consulted before onramp create and before `mppx.fetch`. `simulation_paused` alone is insufficient if a paid worker is already past the pause check. |
| 6 | Deliberate paid test path only (separate test wallet, smallest cap) — never coupled to CI | **Open as process.** `pnpm check` must stay model-free. First live OpenRouter call: Production (or explicitly approved env), tiny `max_tokens` / micros cap, human approval. No GitHub Actions secret for `OPENROUTER_API_KEY`. | **Open as process.** First live `wallets().create` uses a throwaway Privy app / test user, not CI. Ordinary Preview must not mint real wallets. | **Open as process** ([ROADMAP.md](../ROADMAP.md) §7.6). Separate test wallet, smallest onramp amount, smallest MPP cap. Never `AGENT_WORLD_LIVE_MPP=true` in CI or ordinary Preview. Human sandbox proof of Tempo USDC **before** enabling hosted spend. |

**Fail-closed vs deterministic (item 2):** these are different states. Deterministic fallback is the **default** when live flags are false (CI, Preview, today’s production). Hard-fail-closed is when an operator **enabled** a live flag but secrets/allowlist/caps are missing or pause is on — then do not call the vendor and do not write a successful live cost row.

---

## #3 OpenRouter — model-backed character behavior

**Keep separate from Privy/Stripe spend.** Hosted inference should use an OpenRouter **API key**, not `openrouter.mpp.tempo.xyz`.

### APIs / SDKs

- Server-only `POST https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`. First-party option: `@openrouter/sdk`. Direct `fetch` matches local code.
- Controls already sketched locally: `model` from `MODEL_OPTIONS`, `max_tokens: 2000`, completion diagnostics (usage, finish reason, lengths — not prompt/content). Add an AbortSignal timeout **under** the Vercel function `maxDuration` (60s in `vercel.json`).
- Optional OpenRouter: per-key credit cap (`GET /api/v1/key`), `provider.max_price`, `HTTP-Referer` / `X-OpenRouter-Title` for attribution.
- Docs: [authentication](https://openrouter.ai/docs/api_reference/authentication), [parameters](https://openrouter.ai/docs/api_reference/parameters), [limits](https://openrouter.ai/docs/api_reference/limits).

### Env (Vercel Production, server-only)

| Name | Notes |
| --- | --- |
| `OPENROUTER_API_KEY` | Already reserved in `.env.example`. Never browser. |
| `OPENROUTER_MODEL` | Optional default; character `model` must still be in `MODEL_OPTIONS`. |
| `AGENT_WORLD_LIVE_MODELS` | Off ⇒ deterministic. On + key + allowlisted model ⇒ live call. On without key ⇒ hard fail (QA item 2). |
| Optional `AGENT_WORLD_MODEL_TIMEOUT_MS` | Cap below function duration. |

Do not put the key in Preview or GitHub Actions.

### Server-side policy

- Call only from hosted job/mutation handlers after Neon Auth ownership checks (same as today’s character mutations).
- Allowlist models via existing `MODEL_OPTIONS`. Reject client-supplied model strings outside that enum.
- Treat model output as untrusted: keep `safeDecision()`, JSON parse bounds, no payment/policy tools in the prompt.
- Log model id, usage tokens, latency, finish reason. Never log API key, full prompts, reasoning, or raw completions.
- Port SQLite `reserveCost` / `settleCost` / `releaseCost` onto `HostedStore`. Neon already has `cost_entries` but **no reservation API** — hosted autonomy cannot enforce budgets until that exists. Virtual micros remain an app ledger, not OpenRouter credits.

### What stays deterministic

Hosted `jobs.ts` is fully heuristic today (no `PaidServices`). `AGENT_WORLD_LIVE_MODELS` false or unset ⇒ keep that path (`pnpm check` must not hit OpenRouter). Flag true without `OPENROUTER_API_KEY` ⇒ hard fail that job, not a silent deterministic success labeled as live.

### Dependencies

Neon Auth is live. No Privy/Stripe needed. Blocked on: reservation port to Postgres, `AGENT_WORLD_LIVE_MODELS` gate, operator timeout/logging choices.

### Open decisions (ROADMAP)

- Exact production token/timeout/cost caps (`MAX_LLM_REQUEST_MICROS` is 5_000 locally).
- Whether hosted ticks call the model every interval or only for conversation/memory.
- Confirm `MODEL_OPTIONS` ids (`z-ai/glm-5.3-flash`, `openai/gpt-5.6-luna`, `deepseek/deepseek-v4-flash`) still exist on OpenRouter at implement time.

### QA risks (short)

Checklist: **1** hold (no OpenRouter in CI/Preview today). **2** fail-closed if flag on without key — not implemented. **3** redact/prompt rules — not implemented. **4** inherit hosted auth; don’t take character id from the client for completions. **5** hosted `reserveCost` + runtime spend pause — missing. **6** no CI key; first live call is manual.

---

## #4 Privy — one wallet per Neon Auth user

Wallets are not in the schema. Identity stays Neon Auth (`fetchSessionUserId` → `owner_id`).

### APIs / SDKs

- Server: `@privy-io/node` `PrivyClient({ appId, appSecret })`. Create user + Ethereum wallet (`chain_type: 'ethereum'`). Tempo is a default Privy EVM network (chain id **4217**, CAIP-2 `eip155:4217`; testnet Moderato `eip155:42431`).
- Recommended for **offline autonomous spend:** server-owned wallet (authorization key as owner, or additional signer with policies). Store `privy_user_id`, `privy_wallet_id`, public `address`, chain metadata. `external_id` can be the Neon user id (write-once, URL-safe, ≤64 chars).
- Alternative (human-in-the-loop): custom JWT auth against Neon Auth JWKS (`{NEON_AUTH_BASE_URL}/.well-known/jwks.json`, `sub` = user id) and `user_jwts` on each sign. That **cannot** pay while the user is offline unless a server signer is also attached.
- Browser: public address only. No Privy client signing SDK required for #4. Never ship `PRIVY_APP_SECRET` or authorization private keys. `PRIVY_APP_ID` is often public for client SDKs; keep it server-only if the client never talks to Privy.
- Docs: [create wallet](https://docs.privy.io/wallets/wallets/create/create-a-wallet), [server-side user wallets](https://docs.privy.io/recipes/wallets/server-side-user-wallets), [authorization keys](https://docs.privy.io/controls/authorization-keys/keys/create/key), [Tempo txs](https://docs.privy.io/recipes/tempo/send-transactions), [JWT auth](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/setup).

### Env (Production, server-only)

| Name | Notes |
| --- | --- |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Already reserved. Dashboard app credentials. |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | Proposed. Server signer; treat as a wallet root. |
| Optional `PRIVY_POLICY_ID` | Restrict Tempo USDC transfers / MPP contracts. |
| Provisioning gate | Same “not in CI/Preview” rule; e.g. only create wallets when an explicit live-wallet flag is on **or** only in Production. |

### Server-side policy

- Provision on authenticated session, idempotent: one row per `owner_id`. Unique constraint on `owner_id` and on `privy_wallet_id`.
- Ownership: only the Neon session user (or admin) can read their address. No signing endpoints on the public API.
- Policies on the Privy wallet must cap what the server signer can do; app-level caps in #5 are a second layer, not a substitute.
- Never persist private keys, authorization JWTs, or session signers. Do not put addresses or wallet ids into model context.

### What stays deterministic

CI/Preview: skip Privy HTTP; tests mock `wallets().create`. Ordinary previews do not create real wallets.

### Dependencies

Neon Auth live. Blocks #5. Independent of OpenRouter (separate review). Need a `user_wallets` (or similar) migration.

### Open decisions (ROADMAP)

- **Wallet control model:** server-owned + policy vs user-owned + server additional signer. ROADMAP requires server-side signing/delegation; issue text says “embedded wallet.” Resolve before schema.
- Neon Auth JWT plugin (EdDSA, 15‑minute tokens, no custom claims) vs cookie session only — if user-owned wallets are chosen, confirm Privy custom JWT accepts Neon’s JWKS/alg.
- Withdrawal / user-deletion / wallet recovery.

### QA risks (short)

Checklist: **1** no Privy in CI/Preview today. **2** provisioning gate + fail-closed without secrets — not implemented. **3** keys/signer never in browser/DB — design required. **4** wallet routes must use Neon session owner, not a client owner id. **5** no spend in #4; pause must still block provisioning/signing. **6** first live wallet is manual, not CI.

---

## #5 Stripe Crypto Onramp + MPP

Virtual `daily_budget_micros` / `spent_today_micros` / `cost_entries` are **not** onchain balances. UI must keep saying that.

### APIs / SDKs

**Onramp (funding)**

- Server: Stripe Node SDK `stripe.cryptoOnrampSessions.create` → `POST /v1/crypto/onramp_sessions`. Return `client_secret` to an authenticated owner; render Stripe’s embedded onramp. Never put `STRIPE_SECRET_KEY` in the browser.
- Lock destination: `destination_networks: ['tempo']`, `destination_currencies: ['usdc']`, `destination_network: 'tempo'`, `destination_currency: 'usdc'`, `lock_wallet_address: true`, `wallet_addresses.tempo` = Privy public address (confirm the exact `wallet_addresses` key in sandbox; Tempo is a documented network enum).
- Webhooks: `crypto.onramp_session` status → `fulfillment_complete`. Verify signatures with `STRIPE_WEBHOOK_SECRET`. Persist session id, amount, tx id, destination address/network/asset.
- Stripe docs now list Tempo + USDC.e at `0x20c000000000000000000000b9537d11c60e8b50` — **same contract** local MPP already allowlists. API support ≠ a proven delivery into a Privy address.
- Docs: [create session](https://docs.stripe.com/api/crypto/onramp_sessions/create), [embedded onramp](https://docs.stripe.com/crypto/onramp/embedded), [USDC on Tempo](https://docs.stripe.com/crypto/onramp/embedded-components-integration-guide). At implement time, provision Stripe via Vercel Marketplace rather than hand-copied keys.

**MPP (spend)**

- Replace local `mppx` **CLI**/keychain (`apps/server/src/mppx.ts`) with `mppx` + `viem` + Privy `createViemAccount` (`@privy-io/node/viem`, v0.20+). Do **not** polyfill global `fetch` on Vercel.
- Keep the existing 402 flow: select `method=tempo` + `intent=charge` + Tempo mainnet USDC only (`chainId` 4217, token `0x20c000000000000000000000b9537d11c60e8b50`). Reject other challenges.
- Privy’s MPP recipe example uses PathUSD (`0x20c0…0000`), not USDC. **Do not copy that currency.** Our allowlist is USDC.
- Settle from `Payment-Receipt`; treat retries as at-least-once. Reservation id / challenge id must be idempotent keys.
- Docs: [HTTP 402](https://mpp.dev/protocol/http-402), [mppx client](https://mpp.dev/quickstart/client), [Privy + MPP](https://docs.privy.io/recipes/agent-integrations/mpp), [Tempo OpenRouter MPP host](https://tempo.xyz/developers/docs/guide/machine-payments/use-cases/ai-model-access).

Paid endpoint allowlist (local live path today): OpenRouter MPP host, Exa search, OpenAI image MPP host. Hosted #5 should start narrower (e.g. Exa + images only if still desired). **#3’s API-key OpenRouter is not an MPP endpoint.**

### Env (Production, server-only)

| Name | Notes |
| --- | --- |
| `STRIPE_SECRET_KEY` | Onramp + webhooks. |
| `STRIPE_WEBHOOK_SECRET` | Signature verify. |
| `AGENT_WORLD_LIVE_ONRAMP` / `AGENT_WORLD_LIVE_MPP` | Independent; both default off. |
| Existing `MPPX_*` | Local CLI only; do not use on Vercel. |

### Server-side policy

- Onramp session only for the authenticated owner’s Privy address; never a client-supplied address.
- Caps: per-action (`maxMicros` already in local `budgeted()`), per-character `daily_budget_micros`, global `server_daily_budget_micros`. Add a per-user cap if many characters share one wallet.
- **Atomic reserve → network → settle/release** (SQLite already does this; hosted store must grow the same API). On `PaidMppRequestError`, settle the charged amount; on other failures, release. Duplicate jobs must not pay twice (dedupe on reservation/challenge/receipt).
- Model never chooses endpoints, amounts, or wallets. Allowlist is server constant. Conversation/memory/tool text cannot change policy.
- Distinguish three numbers in UI: virtual budget remaining, last onramp receipt, onchain USDC (read-only).

### What stays deterministic

`AGENT_WORLD_LIVE_MPP=false` ⇒ fake costs + fallbacks (local behavior). Hosted stays heuristic until both MPP flag and wallet exist. CI never signs 402s or creates onramp sessions.

### Dependencies

Blocked on #4 (destination wallet + server signer). OpenRouter API-key path (#3) is **not** a blocker. Hosted `reserveCost` is a blocker for safe spend even with a wallet.

### Open decisions (ROADMAP) — especially Tempo + USDC

1. **Prove** Onramp → Privy address → Tempo USDC (`0x20c0…8b50`) with `lock_wallet_address`, then a smallest MPP charge. Docs say the enum/token exist; this repo has not proven the hop.
2. Owner-wallet spend vs platform wallet + internal balances — do not blur ([ROADMAP.md](../ROADMAP.md) §1.4). Issue #5 implies owner wallet + virtual caps.
3. Production numeric caps, funding min/max, withdrawal/recovery, who may enable live flags.
4. Whether MPP should ever pay OpenRouter, or OpenRouter stays API-key-only (#3).

### QA risks (short)

Checklist: **1** no Onramp/MPP in CI/Preview today. **2** live flags + allowlist + fail-closed — not implemented on hosted. **3** receipts only, no secrets in metadata. **4** onramp/MPP bound to session owner’s Privy address. **5** hosted atomic reserve + challenge/receipt idempotency + **spend pause without redeploy** — missing. **6** ROADMAP §7.6 separate test wallet; Tempo USDC hop still unproven.

---

## Recommended build order

1. **#3 OpenRouter (API key)** — hosted `reserveCost`, `LIVE_MODELS` gate, server fetch, deterministic fallback. Separate PR/review.
2. **#4 Privy** — one wallet per Neon user, server signer, no spend. Separate PR/review.
3. **Sandbox proof (human)** — Onramp USDC on Tempo into that wallet; then a $0.00x MPP charge to an allowlisted host.
4. **#5** — hosted MPP via Privy+`mppx`, onramp UI, receipts, spend pause. Only after (3).

Do not enable any of this to merge a code PR into ordinary Preview.

---

## Open decisions / unknowns (human)

Must decide before implement:

- Server-owned vs user-owned Privy wallet (offline spend requires a server signer).
- Owner wallet vs platform wallet economic model.
- Numeric caps, funding rules, withdrawal, and a **runtime spend pause** (simulation + all spending, no redeploy — QA item 5). Env-only flags are insufficient because Vercel env changes redeploy.
- Confirm Onramp actually credits USDC (not PathUSD) to a Privy EVM address on Tempo.
- Whether hosted OpenRouter stays API-key forever or later switches to MPP.
- Re-validate OpenRouter model ids at implement time.

Not blockers for #3: Privy, Stripe, Tempo.

---

## Links

- Issues: [#3 OpenRouter](https://github.com/narulaskaran/agent-world/issues/3), [#4 Privy](https://github.com/narulaskaran/agent-world/issues/4), [#5 Onramp + MPP](https://github.com/narulaskaran/agent-world/issues/5)
- [ROADMAP.md](../ROADMAP.md) (hosted sequence; re-verify vendors rather than this file)
- `.env.example` already reserves `OPENROUTER_*` and `PRIVY_*`; it does not reserve Stripe or live-model/onramp flags yet (leave it that way until implement)
