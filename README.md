# Agent World

A local-first world of autonomous characters. You clone the repo, run
`pnpm start`, and they keep moving, meeting, talking, and remembering on your
machine. With no keys they run on a built-in keyless brain: free, offline,
and still chatty. With an optional OpenRouter key they think with an LLM; with
an optional local `mppx` wallet they can pay for web search and avatars.

This repository no longer hosts a shared public world. The old hosted stack
lives on the `archive/hosted` branch and in [`docs/archive`](./docs/archive).

## Quickstart

Needs Node 24 and pnpm 10.

```bash
git clone https://github.com/narulaskaran/agent-world
cd agent-world
pnpm install
cp .env.example .env   # optional: add keys
pnpm start             # http://127.0.0.1:4310
```

On an empty world, click **Add a starter cast** to meet three characters, or
create your own. Click anyone to follow them. **World settings** (the brain
chip in the header) shows which brain is running and lets you change the world
speed, budget, pause, or reset.

`pnpm dev` runs the API and Vite client separately. `pnpm smoke` hits a
temporary keyless server. `pnpm check` typechecks, tests, and builds every
workspace; `pnpm format:check` runs Prettier.

## Config

Copy `.env.example` to `.env`. All of these are optional except that the
defaults assume localhost.

| Variable                                 | Default                 | Purpose                                                                                   |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `AGENT_WORLD_HOST`                       | `127.0.0.1`             | Bind address. Admin routes are unauthenticated; do not expose the port.                   |
| `AGENT_WORLD_SERVER_PORT`                | `4310`                  | HTTP and WebSocket port.                                                                  |
| `AGENT_WORLD_DATABASE`                   | `./data/agent-world.db` | SQLite file (created automatically).                                                      |
| `AGENT_WORLD_WEB_ORIGIN`                 | `http://localhost:4311` | CORS origin for Vite dev. Production is same-origin.                                      |
| `AGENT_WORLD_ALLOWED_HOSTS`              | empty                   | Extra `Host` names to accept, comma-separated. Others are rejected (DNS-rebinding guard). |
| `VITE_API_URL`                           | empty                   | Vite-only API base; leave empty so production uses same-origin.                           |
| `AGENT_WORLD_DECISION_SCALE`             | unset                   | World speed (`0.1`–`60`). Overrides World settings on start when set.                     |
| `AGENT_WORLD_REACTION_COOLDOWN_MS`       | `10000`                 | Minimum delay between reactions for one character.                                        |
| `AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS` | unset (`2000000`)       | Server-wide daily cap (`2000000` = $2). Overrides World settings on start when set.       |
| `OPENROUTER_API_KEY`                     | empty                   | The only inference key: chat plus JEV decisions.                                          |
| `AGENT_WORLD_JEV_DECISIONS`              | empty                   | Set to `false` to skip JEV and use OpenRouter LLM decisions.                              |
| `AGENT_WORLD_JEV_MODEL`                  | `typesafe/jev-1.13`     | OpenRouter Decisions model id (alpha).                                                    |
| `AGENT_WORLD_LIVE_MPP`                   | `false`                 | Pay-as-you-go paid tools via local `mppx`. Off until `pnpm wallet:setup`.                 |
| `MPPX_BIN`                               | empty                   | Optional path to the `mppx` binary; `pnpm install` provides one.                          |
| `MPPX_ACCOUNT`                           | `agent-world`           | Local `mppx` account name in the OS keychain.                                             |
| `LOG_LEVEL`                              | `info`                  | Fastify log level.                                                                        |

## Costs and safety

The world runs free with no keys; keyless runs never record spend. JEV
decisions use OpenRouter's alpha Decisions API. If a provider fails (network,
auth, empty reply), that step falls back to the keyless brain, and repeated
failures pause the provider for a while; nobody stalls. With keys, spend is
capped by each character's daily budget and by the server-wide daily budget
(default $2/day). The server binds `127.0.0.1` by default and rejects requests
with a foreign `Origin` or an unknown `Host`, but admin routes are
unauthenticated, so do not expose the port.

## Speed

World speed divides every scheduled decision interval and conversation pause.
`1` is real time (a 60s interval stays 60s); `30` makes it two seconds. Change
it any time from World settings (it is saved with the world), or pin it with
`AGENT_WORLD_DECISION_SCALE`. Higher speeds spend faster when keys are set; the
budget caps still apply.

## Wallet (optional)

`pnpm wallet:setup` creates a local `mppx` account. The key stays in your OS
keychain; no script exports or moves it. You fund the printed address yourself
with a small amount of USDC on Tempo mainnet. `mppx` adds about 107 MB to the
install and is an optional dependency, so a failed install does not block the
rest. Linux needs `libsecret-tools` and a running secret service.

## Layout

- `apps/site` — static marketing page (this is what Vercel deploys)
- `apps/web` — the interactive world UI, served by the local server
- `apps/server` — Fastify + WebSocket runtime
- `packages/shared` — Zod contracts, map data and hex geometry
- `packages/db` — SQLite store

See [AGENTS.md](./AGENTS.md) for agent notes and [HANDOFF.md](./HANDOFF.md) for
current state.
