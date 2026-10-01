# Audit validation and implementation plan

Source: the October 2026 audit of `main` (`pnpm check` green, 53 server tests).
Every item was re-checked against the code before planning. Verdicts:

- **Confirmed**: the code behaves as the audit says.
- **Adjusted**: the problem is real but the audit's cause, scope or fix is off.
- **Refuted**: the claim does not hold; nothing to fix beyond what is noted.

## Validation

### Fix first

| #   | Verdict   | Evidence                                                                                                                                                                                                                                                                                       |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Confirmed | `budgeted()` reserves and settles `fakeCostMicros` when `live` is false.                                                                                                                                                                                                                       |
| 2   | Confirmed | `runDueJobs` skips budget sleepers before re-checking the budget. Also found: the midnight reset sets **every** non-paused character to `active`, including ones that are talking or moving.                                                                                                   |
| 3   | Confirmed | The deterministic fallback runs only when JEV was attempted and the error text is "OpenRouter paused…". Directive/event decisions never fall back.                                                                                                                                             |
| 4   | Confirmed | `handleQueueItem` completes the item on error; nothing re-enqueues the turn. Empty content throws.                                                                                                                                                                                             |
| 5   | Confirmed | `conversation_turn` has no dedupe key, so a directive turn forks a second chain; `messageCount + 1` is a stale read-then-write.                                                                                                                                                                |
| 6   | Confirmed | `clearLandmarkFootprint` has no northern bound: the café waypoint is pushed past the café and then past the library (same x-corridor); the park waypoint is pushed to the Tinker Shed.                                                                                                         |
| 7   | Confirmed | `world-scene.ts` uses a fixed 1.6 s tween; the snapshot carries no arrival time.                                                                                                                                                                                                               |
| 8   | Confirmed | CORS only hides responses; nothing checks `Origin`/`Host`. WebSockets ignore CORS. `/api/admin/pause` treats a missing body as "unpause"; `/api/admin/reset` takes no body.                                                                                                                    |
| 9   | Confirmed | `settleCost` clamps the recorded amount to the reservation.                                                                                                                                                                                                                                    |
| 10  | Adjusted  | Real, but the root cause is that chat requests never ask OpenRouter for usage accounting (`usage: { include: true }`). Charging the reservation when cost is unknown is the safe direction and stays; the request is fixed so cost is reported. Cannot be checked live without spending money. |
| 11  | Confirmed | Capabilities advertise web search whenever a key exists; without a wallet the fallback text is canned and still billed 5,000 micros. Results only reach the model as a feed summary.                                                                                                           |
| 12  | Confirmed | Inspector prefers the one-time `detail` fetch over live snapshot fields.                                                                                                                                                                                                                       |
| 13  | Confirmed | Budget inputs PATCH on every blur; empty input sends 0 (fails validation for characters, sets $0 for the world).                                                                                                                                                                               |
| 14  | Confirmed | `tryStartConversation` checks `paused` but not `sleeping`; pausing mid-conversation leaves the partner in a dead conversation.                                                                                                                                                                 |
| 15  | Confirmed | `locationId: null` is hard-coded, so JEV's `people_there` is always 0.                                                                                                                                                                                                                         |

### Smaller correctness bugs

| Item                                   | Verdict   | Notes                                                                                                                    |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `end_conversation` / `respond` ignored | Adjusted  | True, but decisions are never made mid-conversation, so the fix belongs in dialogue: let a speaker end the conversation. |
| `inspect_location` == `move`           | Confirmed |                                                                                                                          |
| Event feed is the transcript store     | Confirmed | 100-row cap applies to transcripts, history and memory extraction.                                                       |
| `new_character` approaches nearest     | Confirmed | Queue items also run mid-conversation and can walk a character away.                                                     |
| Tinker Shed never visited keyless      | Confirmed | Lockstep comes from keying on the wall-clock minute.                                                                     |
| Waypoints outside their rectangle      | Confirmed | Café (300,300), (382,245); park (960,385).                                                                               |
| `REACTION_COOLDOWN_MS` NaN             | Confirmed | Raw `Number()` in two places; `loadConfig` also does not validate it.                                                    |
| Global budget env only at creation     | Confirmed | `/health` reports the env value.                                                                                         |
| Admin modal "Deterministic"            | Confirmed |                                                                                                                          |
| Pause/resume no-op events              | Confirmed |                                                                                                                          |
| Memory extraction hard-codes model     | Confirmed |                                                                                                                          |
| Inspect `reputation: 0`                | Confirmed |                                                                                                                          |
| "Friend" needs 20 conversations        | Confirmed |                                                                                                                          |
| No SIGINT handler                      | Confirmed | Fix both the shutdown and startup recovery (crashes leave the same state).                                               |
| Partner modified without its lease     | Confirmed |                                                                                                                          |
| Personality updates dropped after 800  | Confirmed |                                                                                                                          |

### Efficiency

| Item                                | Verdict   | Notes                                                                                                                                                                                                             |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full world re-sent every second     | Confirmed |                                                                                                                                                                                                                   |
| Avatars as data URLs in snapshots   | Confirmed |                                                                                                                                                                                                                   |
| No pruning, no indexes              | Adjusted  | One index exists (`character_queue` dedupe). Everything else is accurate.                                                                                                                                         |
| ~5 writes/s per idle character      | Confirmed |                                                                                                                                                                                                                   |
| Every decision loads all memories   | Confirmed |                                                                                                                                                                                                                   |
| Bundles large (`import * as THREE`) | Adjusted  | The site already uses named imports and is still 537 KB: the size is the WebGL renderer, not the namespace import. The web main chunk does pull `zod` in through `@agent-world/shared`; that is the fixable part. |
| `mppx` hard dependency              | Confirmed | Only used by `wallet:setup` and the paid-tool spawner; it can be optional.                                                                                                                                        |

### Product and UX, Hygiene

All confirmed by reading `App.tsx`, `styles.css`, `index.html`, CI and the
schema, except:

- **`.env*` ignore pattern** (adjusted): `.env.example` is already tracked, so
  edits are safe; only a re-created file would be swallowed. Add a negation.
- **Site has no favicon** (confirmed for `apps/site`; `apps/web` has one).

## Plan

Work lands on one branch in the order below, each group with tests.

### A. Local-server hardening (item 8)

- `onRequest` hook: reject requests whose `Host` is not a loopback name on the
  configured port (or in `AGENT_WORLD_ALLOWED_HOSTS`), and requests whose
  `Origin` is present but not same-origin or `AGENT_WORLD_WEB_ORIGIN`. Applies
  to the WebSocket upgrade too.
- `POST /api/admin/pause` validates `{ paused: boolean }`; `POST
/api/admin/reset` requires `{ confirm: "reset" }`.

### B. Budgets and fallbacks (items 1, 2, 3, 9, 10, 11)

- Keyless calls never reserve or record cost. Budget sleep only applies when a
  paid brain is configured.
- Budget sleepers wake as soon as their budget allows; the midnight reset only
  wakes budget sleepers.
- Any live failure (network, auth, empty or unparsable reply) falls back to the
  deterministic result and releases the reservation; only budget exhaustion
  propagates.
- `settleCost` records the real amount (overage included).
- Chat requests send `usage: { include: true }` and a lower `max_tokens`.
- Web search is only advertised when a paid tool transport exists; results are
  stored as a memory the model can see.

### C. Conversation state machine (items 4, 5, 14, end/respond, leases)

- One turn token per conversation (`dedupeKey`), atomic message count.
- A mid-conversation directive rides on the character's next turn instead of
  forking a chain.
- Failed turns retry once, then end the conversation instead of stalling.
- `isAvailableForConversation()` (not paused, sleeping or busy) used
  everywhere; pausing, sleeping or deleting ends the conversation.
- Starting a conversation claims the partner's lease; a decision that returns
  after its character was pulled into a conversation is dropped.
- Speakers can end a conversation (LLM `end` flag; deterministic length varies
  per pair); `respond` outside a conversation becomes a spoken line.
- Non-conversation queue items wait while a character is talking;
  `new_character` targets the newcomer.

### D. Rendering (items 6, 7)

- Landmark clearance only applies inside the building's own z-band.
- Snapshot carries `movementArrivesAt`; the client tweens over the real
  remaining time.

### E. Data model and efficiency

- `locationId` derived from position (item 15).
- New `conversation_messages` table for transcripts; events retained to 2,000
  with the snapshot sending the latest 100.
- Periodic pruning of costs, finished queue rows, old conversations and
  inactive memories; indexes on hot paths.
- Queue housekeeping once per tick; idle characters do no writes.
- `buildContext` loads only the deciding character's memories.
- Snapshot publishing is change-driven (coalesced) with a slow heartbeat;
  snapshots drop memories/relationships (the inspector fetches them) and serve
  avatars by URL.
- Web imports zod-free shared entry; `mppx` becomes optional.

### F. Smaller correctness

- `inspect_location` walks there and records a grounded observation on
  arrival.
- Keyless movement covers all five places with per-character randomness.
- Waypoints moved inside their rectangles (with a test).
- Validated reaction cooldown passed into the engine.
- Env global budget applied at startup; `/health` reports the stored value.
- Pause no-ops are silent; memory extraction uses the character's model;
  inspect returns real reputation; relationship tiers reachable (1/3/8);
  SIGINT/SIGTERM shutdown plus lease/queue recovery at startup; personality
  updates keep the newest owner notes.

### G. Product and UX

- "Add a starter cast" on the empty map.
- Richer keyless dialogue and memories (phase-aware templates using
  personality, place, purpose and memories; varied length).
- "While you were away" recap.
- Brain indicator with setup hint; model/budget fields hidden in keyless mode;
  admin shows the real mode.
- Conversation events carry `conversationId` (no more `conversation:<uuid>`
  details); feed threads conversations, filters by character and names are
  clickable.
- Varied conversation openers.
- Avatars shown on the pawn; pawn palette hashed from the full name.
- Tinker Shed artifacts: characters leave notes there; others read them and
  remember.
- Relationship tier and affinity bar, reputation in the inspector.
- World speed adjustable at runtime from the admin modal; conversation pace
  scales with it.
- Hosted-era copy removed.
- Camera follow, Escape closes the inspector, modal focus trap, bounded header
  chips, "server unreachable" state, self-hosted fonts.
- Site: favicon, OG image, product-like "See it run" section.

### H. Hygiene

- Prettier clean; CI runs `format:check` and `pnpm smoke`.
- Dead hosted-era code removed.
- Schema drift test (raw SQL vs Drizzle) and `COLLATE NOCASE` parity.
- `ROADMAP.md` archived; site reuses shared hex helpers.
- Web dev server binds `127.0.0.1`; `.gitignore` keeps `.env.example`.

## Status and deviations

Every group above is implemented with tests. `pnpm check`, `pnpm format:check`
and `pnpm smoke` pass. Runtime checks against a live keyless server: zero spend
and zero ledger rows; foreign `Origin`, rebinding `Host` and cross-origin `/ws`
upgrades get 403 while same-origin upgrades succeed; conversations end
naturally under the 20-message cap with no repeated lines. An outage run (fake
key in memory, every fetch failing) kept characters talking on the keyless
brain, paused the provider after six attempts and recorded no spend.

Deviations from the plan:

- **Avatars** appear in the name chip above the pawn rather than as a texture
  on the voxel pawn, which reads poorly at map zoom.
- **Site "See it run"** uses two real app screenshots instead of a video; the
  1200×630 `og.png` is a screenshot too. No demo video is needed anymore.
- **Item 10** (`usage: { include: true }`) is covered by request-shape tests
  only; confirming reported costs needs a live key and real spend.
- **`.env.example`** comments out world speed and global budget: when set they
  override World settings on every start, which surprised users who copied the
  file.
- **`mppx`** is an optional dependency: still installed by default, but its
  failure no longer breaks `pnpm install`. Paid tools fall back when the
  binary is missing.
- **Smoke** also asserts the keyless brain, foreign-origin rejection, the
  explicit pause body and zero spend, and forces keys empty so a developer's
  `.env` cannot enable paid providers.
