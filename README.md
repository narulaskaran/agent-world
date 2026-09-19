# Agent World

A local-first world of autonomous characters. You clone the repo, run
`pnpm start`, and they keep moving, meeting, talking, and remembering on your
machine. With no keys the world is deterministic and free. With an optional
OpenRouter key they think out loud; with an optional local `mppx` wallet they
can pay for web search and avatars.

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

`pnpm dev` runs the API and Vite client separately. `pnpm smoke` hits a
temporary server. `pnpm check` typechecks, tests, and builds every workspace.

## Config

Copy `.env.example` to `.env`. All of these are optional except that the
defaults assume localhost.

| Variable                                 | Default                 | Purpose                                                                                   |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `AGENT_WORLD_HOST`                       | `127.0.0.1`             | Bind address. Admin routes are unauthenticated; do not expose the port.                   |
| `AGENT_WORLD_SERVER_PORT`                | `4310`                  | HTTP and WebSocket port.                                                                  |
| `AGENT_WORLD_DATABASE`                   | `./data/agent-world.db` | SQLite file (created automatically).                                                      |
| `AGENT_WORLD_WEB_ORIGIN`                 | `http://localhost:4311` | CORS origin for Vite dev. Production is same-origin.                                      |
| `VITE_API_URL`                           | empty                   | Vite-only API base; leave empty so production uses same-origin.                           |
| `AGENT_WORLD_DECISION_SCALE`             | `1`                     | World speed multiplier (`0.1`–`60`). Invalid values become `1`.                           |
| `AGENT_WORLD_REACTION_COOLDOWN_MS`       | `10000`                 | Minimum delay between reactions for one character.                                        |
| `AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS` | `2000000`               | Server-wide daily spend cap (`2000000` = $2).                                             |
| `OPENROUTER_API_KEY`                     | empty                   | The only inference key: chat plus JEV decisions.                                          |
| `AGENT_WORLD_JEV_DECISIONS`              | empty                   | Set to `false` to skip JEV and use OpenRouter LLM decisions (or deterministic if no key). |
| `AGENT_WORLD_JEV_MODEL`                  | `typesafe/jev-1.13`     | OpenRouter Decisions model id (alpha).                                                    |
| `AGENT_WORLD_LIVE_MPP`                   | `false`                 | Pay-as-you-go paid tools via local `mppx`. Off until `pnpm wallet:setup`.                 |
| `MPPX_BIN`                               | empty                   | Optional path to the `mppx` binary; `pnpm install` provides one.                          |
| `MPPX_ACCOUNT`                           | `agent-world`           | Local `mppx` account name in the OS keychain.                                             |
| `LOG_LEVEL`                              | `info`                  | Fastify log level.                                                                        |

## Costs and safety

The world runs free with no keys. JEV decisions use OpenRouter's alpha Decisions
API and fall back to LLM then deterministic decisions if it fails. With keys,
spend is capped by each character's daily budget and by
`AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS` (default $2/day). The server binds
`127.0.0.1` by default. Admin routes are unauthenticated, so do not expose
the port.

## Speed

`AGENT_WORLD_DECISION_SCALE` divides every scheduled decision interval. `1` is
real time (a 60s interval stays 60s). `30` makes that interval two seconds.
Higher values spend faster when keys are set; the budget caps still apply.

## Wallet (optional)

`pnpm wallet:setup` creates a local `mppx` account. The key stays in your OS
keychain; no script exports or moves it. You fund the printed address yourself
with a small amount of USDC on Tempo mainnet. `mppx` adds about 107 MB to the
install. Linux needs `libsecret-tools` and a running secret service.

## Layout

- `apps/site` — static marketing page (this is what Vercel deploys)
- `apps/web` — the interactive world UI, served by the local server
- `apps/server` — Fastify + WebSocket runtime
- `packages/shared` — Zod contracts and map data
- `packages/db` — SQLite store

See [AGENTS.md](./AGENTS.md) for agent notes and [HANDOFF.md](./HANDOFF.md) for
current state.
