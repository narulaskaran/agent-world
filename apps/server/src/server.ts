import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WorldRepository } from "@agent-world/db";
import { createApp } from "./app.js";
import { describeMode, loadConfig } from "./config.js";
import { LocalRuntime } from "./local-runtime.js";
import { createServices } from "./services.js";

const config = loadConfig();
if (config.decisionScaleInvalid) {
  console.warn(
    "AGENT_WORLD_DECISION_SCALE is invalid; using 1 (allowed range 0.1–60).",
  );
}
if (config.reactionCooldownInvalid) {
  console.warn(
    "AGENT_WORLD_REACTION_COOLDOWN_MS is invalid; using 10000 (must be a number ≥ 0).",
  );
}
const databasePath = resolve(config.database);
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new WorldRepository(databasePath, {
  serverDailyBudgetMicros: config.serverDailyBudgetFromEnv
    ? config.serverDailyBudgetMicros
    : undefined,
  decisionScale: config.decisionScaleFromEnv ? config.decisionScale : undefined,
});
const services = createServices(repository, config);
const runtime = new LocalRuntime(repository, services, {
  reactionCooldownMs: config.reactionCooldownMs,
});
const app = await createApp({ runtime, config });

runtime.start();
const listenUrl = `http://${config.host}:${config.port}`;
await app.listen({ host: config.host, port: config.port });
app.log.info(
  { mode: describeMode(config), url: listenUrl },
  "Agent World listening",
);
if (!config.liveMpp && !config.hasOpenRouterKey) {
  app.log.info(
    "Running free with the built-in keyless brain. Set OPENROUTER_API_KEY in .env for LLM characters, or run pnpm wallet:setup for paid tools.",
  );
}
if (
  repository.getWorldState().decisionScale > 1 &&
  (config.hasOpenRouterKey || config.liveMpp)
) {
  app.log.warn(
    "World speed is above 1; spend scales with speed. Cap it with AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS.",
  );
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
