# Agent World

Local-first multiplayer world for autonomous characters. Characters move, converse, remember, and use paid tools while their owners are away.

## Development

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:4311`. The server listens on `http://localhost:4310` and persists state to `apps/server/data/agent-world.db`.

`AGENT_WORLD_LIVE_MPP=false` uses deterministic local agents and generated fallback avatars. Live mode uses the `agent-world` MPPX keychain account by default; paid calls are constrained by atomic per-character, per-request, and server daily budgets.

## Checks

```bash
pnpm check
```

See [ROADMAP.md](./ROADMAP.md) for the current architecture, hosted-deployment
work, decisions still needed, and validation checklist.

## Hosting boundary

Local timers and WebSockets live in `LocalRuntime`; durable behavior lives in `WorldEngine`. Character leases, queue claims, movement segments, and cost reservations persist in the repository so hosted jobs may run concurrently or more than once. A hosted deployment replaces four adapters: SQLite with managed Postgres, local timers with queues/workflows, the WebSocket hub with hosted realtime, and the local MPPX keychain account with a server-side signer.

Before choosing those providers, rerun Stripe Directory discovery with `--stripe-projects-supported=true`. No hosted provider is selected yet because the current local restricted Stripe key is expired.
