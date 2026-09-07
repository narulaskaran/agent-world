# Spike: OpenRouter, Privy, Stripe Onramp + MPP

**Status:** research/scoping only. Do not implement or enable paid/model paths from this document.
**Purpose:** define what is required to ship GitHub issues [#3](https://github.com/narulaskaran/agent-world/issues/3), [#4](https://github.com/narulaskaran/agent-world/issues/4), and [#5](https://github.com/narulaskaran/agent-world/issues/5). Vendor docs re-checked 2026-09-07; this is not a ROADMAP snapshot or a product/legal approval.
**Acceptance meaning:** this spike is scope-complete when it selects a recommended architecture, makes unresolved human decisions explicit, and blocks later gates on them. It must not fabricate a liability/support policy merely to appear launch-ready. Production funding and delegated spend remain intentionally unapproved until product/legal owners resolve the named loss scenarios.

Production today is deterministic hosted mode (`packages/hosted`). Local `PaidServices` still exist behind `AGENT_WORLD_LIVE_MPP`, but hosted jobs never call them.

## Executive recommendation

Ship this as four capabilities delivered through the six separately approved gates below, not one "payments" feature:

1. **Metered model calls:** OpenRouter API-key billing with a hosted virtual reservation ledger. No wallet dependency.
2. **Wallet custody:** a user-owned Privy embedded wallet whose wallet key material is managed by Privy, with a separate Agent World authorization key added after explicit user consent. For v1 that app signer is intentionally broad at the Privy layer; Agent World's backend is the authorization boundary for its use.
3. **Funding proof:** a manual sandbox proves Stripe Onramp delivers the exact Tempo asset to the exact wallet. Do not build a production balance UI from API-shape assumptions.
4. **Delegated MPP spend:** an owner grant lets the app signer pay any backend-registered MPP tool while the backend enforces registry membership, payment validity, and the user's aggregate daily limit. The grant can be paused or revoked independently of simulation.

**Recommended economic model:** owner wallet + app-level virtual limits. Do not implement a platform wallet or pooled internal balances in this sequence. If product later chooses platform custody, rescope #4/#5 because ownership, accounting, withdrawals, and regulatory risk change materially.

**Non-negotiable boundary:** funding, delegation, reservation, credential submission, settlement, and reconciliation are different states. A funded wallet is not authorization to spend; a reserved virtual budget is not an onchain debit; an HTTP success without a verified receipt is not settlement. Virtual limits are safety quotas, never user balances, stored value, or a promise that funds can be withdrawn.

### First-release product contract

| Question                                                                                                                                  | First-release answer / approval gate                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who owns funds?                                                                                                                           | The user owns funds in a user-owned embedded wallet. Agent World does not pool funds or maintain redeemable balances.                                                                                                                                                                                                       |
| What is the virtual budget?                                                                                                               | A revocable safety quota that limits app actions; it is not money, credit, or a withdrawal entitlement.                                                                                                                                                                                                                     |
| Who may spend?                                                                                                                            | The broadly authorized Agent World app signer, after versioned owner consent. Agent World's backend may use it only for payment requests from active registered MPP tools. World admins do not inherit direct signing authority.                                                                                            |
| Where is tool policy enforced?                                                                                                            | In the Agent World backend, not by Privy. Privy does not read the tool manifest. This v1 tradeoff means compromise of the backend signer path could drain the wallet; that risk must be disclosed and mitigated operationally.                                                                                              |
| What is the default spend limit?                                                                                                          | An aggregate **$0.20 USD per user per UTC day**, across all of that user's agents and wallet payment operations. An authenticated user may raise or lower it with explicit confirmation; v1 has no separate product maximum. A change governs new reservations only and does not rewrite amounts already held or submitted. |
| What happens on unauthorized spend, signer compromise, mistaken delegation, merchant failure, onramp failure, or irreversible settlement? | **Unresolved release blocker.** Product/legal must assign responsibility and support/compensation policy per scenario. Until approved, no funding or delegated-spend production gate may open; the runtime response is pause, preserve evidence, and reconcile—never promise or issue an automatic refund.                  |
| How can a user exit?                                                                                                                      | Before production funding, the user must be able to revoke the app signer and recover/export the wallet or transfer all assets to another user-controlled address. Account deletion must not orphan funds.                                                                                                                  |
| What is user-visible?                                                                                                                     | Wallet/onchain balance, funding state, delegation/caps, quota reserved/spent, payment pending/unknown/settled, fees, and support status are distinct labels.                                                                                                                                                                |

---

## Shared gates

Keep CI, ordinary Preview, and default Production deterministic. Live keys belong in Vercel **Production only** (sensitive), never in GitHub Actions, never `VITE_*`.

| Gate                      | Default              | Meaning                                                                                           |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `AGENT_WORLD_LIVE_MODELS` | unset / `false`      | OpenRouter HTTP calls. Proposed; do not reuse `LIVE_MPP`.                                         |
| `AGENT_WORLD_LIVE_MPP`    | `false` (already)    | Onchain MPP 402 payments.                                                                         |
| `AGENT_WORLD_LIVE_ONRAMP` | unset / `false`      | Stripe Crypto Onramp session creation.                                                            |
| `simulation_paused`       | existing admin pause | Stops hosted jobs; **not** a spend kill switch today.                                             |
| Proposed spend-paused bit | off                  | Runtime/DB flag (not Vercel env) so operators can halt model + onramp + MPP **without redeploy**. |

**CI / Preview:** flags false, secrets absent, tests use deterministic fallbacks and in-memory/SQLite/Neon-without-spend. Do not set live keys on Preview “to try it.” First live calls need a dedicated Production (or explicitly approved) wallet, smallest cap, and human approval ([ROADMAP.md](../ROADMAP.md) §7.6).

**Fail closed:** flag off ⇒ deterministic, no vendor call. Flag on + missing secret or failed allowlist check ⇒ **hard fail** (no network spend, no “looks live” fallback). Never spend because a secret was empty.

**Kill switch:** `simulation_paused` stops jobs only. QA requires pausing simulation **and** all spending **without redeploy**. That needs a runtime flag read on every paid/model/onramp call (DB column or equivalent), not Vercel env + redeploy.

Existing `redact()` covers object keys matching cookie/authorization/secret/token/key/email. It does not inspect arbitrary string values and therefore is not sufficient for prompts, completions, wallet material, onramp client secrets, or serialized MPP credentials. Paid paths need allowlisted structured logs rather than broader best-effort redaction. Never pass raw vendor responses or headers to `logEvent()`.

---

## QA locked risk checklist

QA owns the full checklist. This spike maps each locked item to #3 / #4 / #5: **satisfies** (current hosted code or the issue’s required design) vs **open** (must be true at implement; not true today, or a human decision remains).

| #   | Locked item                                                                                                             | #3 OpenRouter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | #4 Privy                                                                                                                                                                                                                                                                                       | #5 Onramp + MPP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CI / previews stay deterministic — no live OpenRouter, Privy spend, or Stripe Onramp in `pnpm check` or preview deploys | **Satisfies today:** hosted jobs never call OpenRouter; `.github/workflows/check.yml` has no model secrets. **Implement must keep:** `AGENT_WORLD_LIVE_MODELS` unset in CI and ordinary Preview; no `OPENROUTER_API_KEY` there.                                                                                                                                                                                                                                                                                                                                                                    | **Satisfies today:** no Privy client/server in repo. **Implement must keep:** no live `wallets().create` in `pnpm check` or Preview; mock only. #4 is provisioning, not spend — still no live Privy in CI/Preview.                                                                             | **Satisfies today:** hosted never signs 402s or creates onramp sessions; local live path is `AGENT_WORLD_LIVE_MPP=false` in tests. **Implement must keep:** both live flags off in CI/Preview; no Stripe/MPP secrets on those envs.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Paid / model calls require explicit env flags + server allowlist; missing secrets = hard fail closed, not silent spend  | **Open at implement.** Design: `AGENT_WORLD_LIVE_MODELS=true` **and** key present **and** model ∈ `MODEL_OPTIONS`. Flag off ⇒ deterministic (not spend). Flag on + missing key ⇒ hard fail, do **not** fall through to a fake “live” success. Local `PaidServices` today falls back whenever `LIVE_MPP` is false; hosted must not treat a missing OpenRouter key as a successful model tick.                                                                                                                                                                                                       | **Open at implement.** Provisioning needs an explicit live-wallet gate (or Production-only). Missing `PRIVY_APP_SECRET` / signer key ⇒ fail closed, no wallet row that looks real. No browser allowlist of wallet actions — there should be **no** public signing API.                         | **Open at implement.** Independent flags `AGENT_WORLD_LIVE_ONRAMP` / `AGENT_WORLD_LIVE_MPP` plus an active, reviewed server registry manifest for the selected MPP tool. Missing Stripe/signer secrets or inactive/invalid registry entry ⇒ hard fail, never a 402 sign or onramp session. Local `budgeted()` fake-spend when live is false is the **deterministic** path, not a missing-secret live path.                                                                                                                                                                                                                                                                                      |
| 3   | Wallet keys / signing / LLM tokens never reach the browser, prompts, logs, or DB rows                                   | **Open at implement** (policy is in the issue). Server-only key; log usage/latency/model id only. Do not persist prompts, completions, reasoning, or `OPENROUTER_API_KEY`. Today’s `redact()` does not cover prompt/completion bodies.                                                                                                                                                                                                                                                                                                                                                             | **Open at implement.** Store provider ids + public address only. Never persist `PRIVY_APP_SECRET`, authorization private keys, or signing JWTs. Public address may be shown to the owner; not in model context.                                                                                | **Open at implement.** `STRIPE_SECRET_KEY` / webhook secret / MPP credentials / `Payment` authorization headers never in client, prompts, logs, or `cost_entries.metadata` beyond receipt ids. Onramp `client_secret` is session-scoped to the owner’s browser widget only — not logged, not in DB.                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | Auth boundaries: spectator read-only; owner can’t mutate another user’s character; admin gated by allowlist             | **Satisfies today** for hosted HTTP: public reads; mutations use Neon session `owner_id`; admin is `AGENT_WORLD_ADMIN_USER_IDS`. **Implement must not regress:** model calls run as server jobs for an **owned** character, not a client-supplied id. Model output cannot grant admin or cross-user mutate.                                                                                                                                                                                                                                                                                        | **Satisfies today** for characters; **open for wallet routes.** Provision/read wallet only for `sessionUserId`; unique one wallet per Neon user. Spectators see no signing surface. Admin allowlist unchanged — admin is not unrestricted wallet control unless explicitly designed.           | **Open at implement** for money routes. Onramp session and MPP spend must use the authenticated owner’s Privy address only (never client-supplied). Cross-user character mutate stays forbidden; paying a tool must not become a mutate. Admin budget/pause stay allowlisted (`/admin/*`).                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | Atomic spend caps + kill switch: pause simulation **and** all spending without redeploy; retries don’t double-pay       | **Partial / open.** Local SQLite `reserveCost` caps inference micros; hosted `HostedStore` **lists** `cost_entries` but cannot reserve. Kill switch: `simulation_paused` stops jobs (including future model ticks) **without redeploy**, but does **not** stop a live HTTP call already in flight, and env flags require redeploy. Need a runtime spend-pause bit read before every OpenRouter call. Idempotency: one reservation per job attempt; no double charge to virtual budget on retry. OpenRouter API-key path has no onchain double-pay, but virtual ledger still must not double-count. | **Open.** #4 should not spend. Kill switch must also block **new wallet provisioning** and any later signer use. No atomic payment yet; unique `(owner_id)` prevents two wallets. The broad server signer is deliberately not the v1 spend brake; backend authorization and runtime pause are. | **Partial / open.** Local `budgeted()` is atomic reserve → call → settle/release; retries can still double-pay **onchain** if a 402 was signed and the job retries without recording challenge/receipt ids — hosted must persist idempotency keys. Cap: one user-overridable aggregate daily USD limit, default $0.20, across all of the user's agents and wallet payment operations; hosted reservation API is missing. Kill switch **without redeploy** is **not** implemented for spend: add global, per-user, and per-tool runtime pauses consulted before onramp create and before signer use. `simulation_paused` alone is insufficient if a paid worker is already past the pause check. |
| 6   | Deliberate paid test path only (separate test wallet, smallest cap) — never coupled to CI                               | **Open as process.** `pnpm check` must stay model-free. First live OpenRouter call: Production (or explicitly approved env), tiny `max_tokens` / micros cap, human approval. No GitHub Actions secret for `OPENROUTER_API_KEY`.                                                                                                                                                                                                                                                                                                                                                                    | **Open as process.** First live `wallets().create` uses a throwaway Privy app / test user, not CI. Ordinary Preview must not mint real wallets.                                                                                                                                                | **Open as process** ([ROADMAP.md](../ROADMAP.md) §7.6). Separate test wallet, smallest onramp amount, smallest MPP cap. Never `AGENT_WORLD_LIVE_MPP=true` in CI or ordinary Preview. Human sandbox proof of Tempo USDC **before** enabling hosted spend.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

| Name                                    | Notes                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`                    | Already reserved in `.env.example`. Never browser.                                                     |
| `OPENROUTER_MODEL`                      | Optional default; character `model` must still be in `MODEL_OPTIONS`.                                  |
| `AGENT_WORLD_LIVE_MODELS`               | Off ⇒ deterministic. On + key + allowlisted model ⇒ live call. On without key ⇒ hard fail (QA item 2). |
| Optional `AGENT_WORLD_MODEL_TIMEOUT_MS` | Cap below function duration.                                                                           |

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
- Recommended for **offline autonomous spend:** a user-owned embedded wallet plus one separately consented Agent World authorization key as an additional signer. For v1, do not constrain this signer with a tool allowlist at the Privy layer: Agent World's backend registry is the authorization boundary. Do not describe this as a server-owned wallet. Store `privy_user_id`, `privy_wallet_id`, public `address`, chain metadata, consent version, and signer-grant status. Use a stable opaque mapping for `external_id` rather than exposing the raw Neon subject across providers. Multi-key quorum is future defense in depth, not a v1 requirement.
- Alternative (human-in-the-loop): custom JWT auth against Neon Auth JWKS (`{NEON_AUTH_BASE_URL}/.well-known/jwks.json`, `sub` = user id) and `user_jwts` on each sign. That **cannot** pay while the user is offline unless a separately authorized app signer is also attached.
- Browser: public address only. No Privy client signing SDK required for #4. Never ship `PRIVY_APP_SECRET` or authorization private keys. `PRIVY_APP_ID` is often public for client SDKs; keep it server-only if the client never talks to Privy.
- Docs: [create wallet](https://docs.privy.io/wallets/wallets/create/create-a-wallet), [server-side user wallets](https://docs.privy.io/recipes/wallets/server-side-user-wallets), [authorization keys](https://docs.privy.io/controls/authorization-keys/keys/create/key), [Tempo txs](https://docs.privy.io/recipes/tempo/send-transactions), [JWT auth](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/setup).

### Env (Production, server-only)

| Name                                | Notes                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Already reserved. Dashboard app credentials.                                                                               |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY`   | Proposed app authorization key. Keep only in managed secrets; it is not a wallet key or recovery credential.               |
| Optional `PRIVY_POLICY_ID`          | Not part of v1 tool enforcement. Reserved for later defense-in-depth restrictions.                                         |
| Provisioning gate                   | Same “not in CI/Preview” rule; e.g. only create wallets when an explicit live-wallet flag is on **or** only in Production. |

### Server-side policy

- Separate **provision wallet** from **grant app signer**. Wallet provisioning must be authenticated and idempotent: one row per `owner_id`, with unique constraints on `owner_id` and `privy_wallet_id`. Adding the broad app signer requires explicit, versioned owner consent that explains Agent World's effective ability to move wallet funds, the backend-only MPP restriction, automatic access to subsequently reviewed/activated registry tools within the user's current limit, pause/revocation behavior, and the backend-compromise risk.
- Ownership: only the Neon session user can read their wallet details. Admin may inspect operational state but must not gain implicit signing or withdrawal authority. No generic signing endpoint exists on the public API.
- For v1, Privy does not interpret the MPP tool registry and does not cap the signer to individual tools or recipients. A single deny-by-default server signing gateway is the only module and deployment identity allowed to access the authorization key or call signer APIs. It must enforce authenticated ownership, active registry/version, validated tool input and payment request, daily user limit, consent/revocation, and runtime pauses before every signature. Admin, model, job, tool adapter, and generic API code may request a typed MPP payment from this gateway but cannot submit a raw transaction or call Privy signing directly. Architecture tests must prove those bypasses are unavailable. Managed-key custody, rotation, emergency disablement, compromise response, and current Privy support remain implementation gates—not assumptions.
- Never persist private keys, authorization JWTs, or session signers. Do not put addresses or wallet ids into model context.
- User deletion must revoke/remove the app signer before deleting the mapping row. Before production funding, select and prove at least one supported user exit path: recover/export the wallet, or transfer all assets to another user-controlled address. If Privy/product policy supports neither, production funding is blocked. Never silently orphan a funded wallet.

### What stays deterministic

CI/Preview: skip Privy HTTP; tests mock `wallets().create`. Ordinary previews do not create real wallets.

### Dependencies

Neon Auth live. Blocks #5. Independent of OpenRouter (separate review). Need a `user_wallets` (or similar) migration.

### Open decisions (ROADMAP)

- **Wallet control model (decided for v1):** user-owned embedded wallet + separately consented, broadly authorized app signer; detailed authorization lives in Agent World's backend rather than Privy policy.
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
- Settle only from a parsed, validated `Payment-Receipt` (method, status, amount, currency, network, payer, merchant, and transaction/reference must match the reserved operation). Treat retries as at-least-once. The stable idempotency key is the app operation/job id plus a request-body digest; challenge ids and receipts are evidence attached to that operation, not substitutes for it. Send `Idempotency-Key` on non-idempotent merchant requests when supported.
- Docs: [HTTP 402](https://mpp.dev/protocol/http-402), [mppx client](https://mpp.dev/quickstart/client), [Privy + MPP](https://docs.privy.io/recipes/agent-integrations/mpp), [Tempo OpenRouter MPP host](https://tempo.xyz/developers/docs/guide/machine-payments/use-cases/ai-model-access).

Paid endpoint allowlist (local live path today): OpenRouter MPP host, Exa search, OpenAI image MPP host. Hosted #5 replaces this fixed list with a server-side, versioned MPP tool registry. **#3’s API-key OpenRouter is not an MPP endpoint.**

### Env (Production, server-only)

| Name                                               | Notes                                 |
| -------------------------------------------------- | ------------------------------------- |
| `STRIPE_SECRET_KEY`                                | Onramp + webhooks.                    |
| `STRIPE_WEBHOOK_SECRET`                            | Signature verify.                     |
| `AGENT_WORLD_LIVE_ONRAMP` / `AGENT_WORLD_LIVE_MPP` | Independent; both default off.        |
| Existing `MPPX_*`                                  | Local CLI only; do not use on Vercel. |

### Server-side policy

- Onramp session only for the authenticated owner’s Privy address; never a client-supplied address.
- Every funding session requires explicit user confirmation of destination wallet, asset/network, requested amount or limits, quoted fees/rate, KYC/geographic eligibility, expected settlement timing, and cancellation/refund limitations. Browser success is not funding proof; signed webhook state and an independent onchain read must reconcile first.
- V1 has one mandatory user-facing wallet-payment cap: an aggregate daily USD limit per owner across all of that user's agents and wallet payment operations. It defaults to **$0.20 per UTC day**. An authenticated user may raise or lower it with explicit confirmation; v1 has no separate product maximum. A change applies to new reservations and never retroactively authorizes, cancels, or rewrites an existing reservation/submission. Account in integer micro-USD; for v1 Tempo USDC, treat one USDC as one USD for quota purposes without an external price oracle. Before signing, reserve the ceiling of the maximum total USDC debit declared by the validated payment request, including merchant/protocol/network fees charged in USDC; reject a request whose maximum total debit is not knowable. Settle the exact verified total debit and release any unused reservation difference. Funding and wallet-management operations do not consume spend quota. Held reservations and settled spend count against the UTC budget day; definite pre-submission release, reconciled non-payment, or a confirmed refund restores available allowance exactly once while preserving immutable historical ledger events. A global emergency pause and per-user/per-tool pauses are operational controls, not additional spend quotas. OpenRouter API-key billing retains its separate model-call ledger and caps; those are not wallet-payment quotas.
- **Atomic reserve → challenge → authorize → submit → settle/reconcile** (SQLite only covers a simpler virtual reserve/settle/release flow; hosted needs a durable payment-attempt state machine). Before credential submission, a definite failure may release the reservation. After credential submission, transport timeout, missing receipt, or malformed response is **unknown**, not free: keep the reservation held, block automatic retry, and reconcile provider/chain state. Duplicate jobs must reuse the stable operation id and must not create a second authorization.
- The agent may choose only a tool id and tool input exposed by the active registry; it never supplies a wallet, recipient, payment destination, or raw signing transaction. Conversation/memory/tool text cannot register or modify tools. The payment service derives and verifies the MPP request from the selected registry entry before signing.
- Distinguish three numbers in UI: virtual budget remaining, last onramp receipt, onchain USDC (read-only).
- The backend registry is the operational source of truth. Version-controlled manifests define stable tool id, exact HTTPS origins/routes/methods, a closed input schema with bounds, deterministic request/amount derivation rules, maximum charge for one operation, MPP method/intent, chain/assets, recipient/destination policy, expected payment mechanism, and risk metadata. Reviewed manifests are activated in hosted registry tables so a tool can be paused without redeploy. The backend validates tool input against the manifest, constructs the request itself, pins and revalidates the resolved public destination at request time, binds the request-body digest, and verifies that the live 402 challenge—including recipient and amount—belongs to the selected tool and matches the manifest before signer use. Tool responses and agent-controlled input can never directly set or widen recipient, amount, chain, asset, or transaction data. Reject redirects, private/link-local destinations, and DNS/address changes that escape the registered origin. Newly reviewed and sandbox-verified tools automatically become available to existing users within their current daily limit; tools cannot self-register.

### Durable payment-attempt states

Persist one row per stable operation id. State transitions are monotonic and conditional:

`reserved → challenged → authorized → submitted → settled`

Terminal/holding alternatives: `rejected`, `expired`, `cancelled`, `unknown`, `reconciled_failed`. Only a definite pre-submission failure or reconciled non-payment releases reserved budget. `submitted` and `unknown` are retry barriers. Store parsed receipt/transaction identifiers and hashes needed for reconciliation, never raw `Authorization`, `WWW-Authenticate`, `Payment-Receipt`, or vendor response bodies.

`reserved`, `challenged`, and `authorized` remain cancelable by the owning user or payment operator before submission. After submission, the user sees **payment pending** or **outcome unknown**, the quota remains held, and neither the user nor an ordinary job can retry or mark it failed. A dedicated server reconciliation role has no signer, funding, policy-change, or arbitrary-write authority: it may query only allowlisted read-only provider/merchant/chain evidence, append immutable evidence hashes/references, and request a conditional `submitted|unknown → settled|reconciled_failed` transition whose amount/asset/network/merchant/transaction match the reserved operation. Every transition is audited; a manual override requires two separately authenticated payment operators and preserves the original state/evidence. Unresolved attempts page the payment operator. `cancelled` means no credential was submitted, while `reconciled_failed` requires affirmative evidence that no payment settled.

The Postgres schema needs uniqueness for the stable operation id and provider/webhook/receipt transaction references, plus conditional updates that make settlement and release exactly-once. Financial methods must fail closed unless the active Neon driver provides a real transaction/locking primitive; `NeonStore.transaction()` currently falls back to running `fn()` without a transaction when `begin` is absent, which is not acceptable for reservation or settlement. Prove the deployed driver behavior with concurrent integration tests before live mode.

The runtime spend pause is checked (with a version/generation) before reservation, immediately before signer use, and immediately before the paid retry. Pausing cannot retract a credential already submitted; those attempts move through reconciliation. The operator control must separately cover model calls, wallet provisioning, onramp session creation, and MPP signing so one subsystem can be halted without pretending an in-flight payment was cancelled.

### What stays deterministic

`AGENT_WORLD_LIVE_MPP=false` ⇒ fake costs + fallbacks (local behavior). Hosted stays heuristic until both MPP flag and wallet exist. CI never signs 402s or creates onramp sessions.

The existing local live MPP proof used a developer-owned CLI/keychain account. It proves only that the local request flow reached and paid a compatible endpoint; it is not evidence for hosted Privy custody, Stripe funding, durable idempotency, receipt validation, or retry safety.

### Dependencies

Blocked on #4 (destination wallet + explicitly consented app signer). OpenRouter API-key path (#3) is **not** a blocker. Hosted `reserveCost` is a blocker for safe spend even with a wallet.

### Open decisions (ROADMAP) — especially Tempo + USDC

1. **Prove** Onramp → Privy address → Tempo USDC (`0x20c0…8b50`) with `lock_wallet_address`, then a smallest MPP charge. Docs say the enum/token exist; this repo has not proven the hop.
2. Owner-wallet spend + a broad app signer + backend-only MPP registry enforcement is the decided v1 model; do not blur it with platform custody or claim Privy enforces tool manifests.
3. Funding min/max, withdrawal/recovery, who may enable live flags, and alert thresholds. The spend default is decided: $0.20 USD per user per UTC day, user-overridable.
4. Whether MPP should ever pay OpenRouter, or OpenRouter stays API-key-only (#3).

### QA risks (short)

Checklist: **1** no Onramp/MPP in CI/Preview today. **2** live flags + allowlist + fail-closed — not implemented on hosted. **3** receipts only, no secrets in metadata. **4** onramp/MPP bound to session owner’s Privy address. **5** hosted atomic reserve + challenge/receipt idempotency + **spend pause without redeploy** — missing. **6** ROADMAP §7.6 separate test wallet; Tempo USDC hop still unproven.

---

## Recommended build order and exit gates

Each stage is a separate change set and approval. Later stages do not start merely because an earlier schema or SDK compiles.

1. **#3 OpenRouter (API key)** — first build the deterministic hosted model-call ledger, then add `LIVE_MODELS`, server fetch, and deterministic fallback. These model-call per-character/user/global caps are separate from the v1 wallet-payment daily limit. Start with explicit owner-triggered directives/conversations rather than every autonomous tick. **Exit:** deterministic CI proves zero vendor calls; concurrency tests prove atomic model-call caps; worst-case daily model spend is modeled from cadence × characters × retries; provider-key and request token/timeout limits bound real billing; missing/ambiguous usage is quarantined; one explicitly approved smallest live probe records usage without content or secrets. Separate PR/review.
2. **#4a Privy provisioning and exit recovery** — one user-owned wallet per Neon user; no app signer and no spend. **Exit:** concurrent provisioning is idempotent; cross-user/admin signing is impossible; only provider ids/public metadata persist; the user can revoke future delegation and recover/export or empty the wallet; funded account deletion cannot orphan assets. Separate PR/review.
3. **#4b Delegation consent** — attach the broad app signer only after explicit owner consent. **Exit:** consent accurately discloses broad Privy-layer authority and backend-only enforcement; the signing service alone can use the key; the $0.20 default daily limit and user override work; revoke and runtime pauses are demonstrated; an administrator cannot directly invoke the signer or silently register a tool.
4. **Sandbox funding proof (human)** — using an isolated non-production Stripe/Privy identity and disposable test wallet only, Onramp the smallest supported amount of USDC on Tempo. This does not approve production funding or resolve the production liability gate. **Exit:** signed Stripe webhook and independent onchain read agree on wallet, asset, amount, status, and transaction; replayed/out-of-order webhooks are idempotent; no production user funds are involved.
5. **Sandbox MPP proof (human)** — from the same isolated non-production identity/test wallet, make one smallest charge to one hard-coded allowlisted merchant. This does not approve production delegated spend. **Exit:** request digest, stable operation id, challenge, authorization submission, validated receipt, onchain result, and ledger settlement reconcile exactly; a lost-response simulation enters `unknown` and does not repay.
6. **#5 production path** — hosted MPP via Privy + `mppx`, versioned backend tool registry, onramp UI, receipts, reconciliation, and independent runtime pauses. **Exit:** the full synthetic matrix below passes, alerts are approved, and rollout starts invite-only with one registered operation.

Do not enable any of this to merge a code PR into ordinary Preview.

### Minimum deterministic test matrix

- Flag off, missing secret, malformed secret, runtime pause, and revoked signer all cause zero vendor/signer calls.
- Two concurrent reservations across any of a user's agents cannot exceed that user's daily USD limit.
- Duplicate queue delivery and repeated webhook delivery converge on one wallet/session/payment attempt.
- Wrong owner, wallet, inactive/unregistered tool, origin, path, method, redirect, chain, token, recipient, amount, body digest, receipt, or manifest version fails closed.
- Failures before credential submission release once; timeout or crash after submission holds the reservation in `unknown` and prevents automatic repayment.
- Reconciliation can prove settled or not-paid and moves the virtual ledger exactly once.
- Logs, alerts, database rows, browser payloads, and model context contain no raw prompts/completions, wallet/signing secrets, authorization/challenge/receipt headers, onramp client secret at rest, or vendor bodies.
- Public UI labels virtual budget, onchain balance, funding status, pending/unknown payment, and settled spend as different concepts.

---

## Open decisions / unknowns (human)

Must decide before implementation (the recommendation above is not product approval):

- **Decided for v1:** user-owned Privy embedded wallets with a separately consented, broadly authorized app signer. Privy manages wallet key material; Agent World stores only its separate authorization key in managed server secrets.
- **Decided for v1:** owner-wallet spend, no platform wallet or pooled balances. Agent World's backend limits signer use to active registered MPP tools; Privy does not see the manifests.
- Define the custody/liability contract in user-facing terms: funds remain in the user-owned wallet; funding is not a deposit with Agent World; the app’s delegated authority and loss responsibility are explicit; product/legal review owns this decision rather than inferring it from SDK terminology.
- Define the exact delegation-screen copy for broad Privy-layer authority, backend-only MPP enforcement, backend-compromise risk, pause/revoke, fee/gas treatment, and queued/in-flight attempts.
- **Decided for v1:** default aggregate limit is $0.20 USD per user per UTC day across all agents and wallet payment operations; users may raise or lower it. Still set funding min/max, operator roles, alerts, and rollout cohort.
- Define withdrawal/export/recovery, account suspension/deletion, abandoned or funded wallets, refund/dispute support, and who owns reconciliation.
- Confirm Stripe Onramp eligibility/KYC/geography and prove it credits USDC (not PathUSD) to the exact Privy address on Tempo.
- Decide whether hosted OpenRouter stays API-key-only; do not make MPP a hidden dependency of #3.
- Re-validate OpenRouter model ids, Privy SDK/policy APIs, Stripe session parameters, MPP receipt fields, Tempo chain/token, merchant origins, and minimum live amounts at implementation time.

Not blockers for #3: Privy, Stripe, Tempo.

---

## Links

- Issues: [#3 OpenRouter](https://github.com/narulaskaran/agent-world/issues/3), [#4 Privy](https://github.com/narulaskaran/agent-world/issues/4), [#5 Onramp + MPP](https://github.com/narulaskaran/agent-world/issues/5)
- [ROADMAP.md](../ROADMAP.md) (hosted sequence; re-verify vendors rather than this file)
- `.env.example` already reserves `OPENROUTER_*` and `PRIVY_*`; it does not reserve Stripe or live-model/onramp flags yet (leave it that way until implement)
