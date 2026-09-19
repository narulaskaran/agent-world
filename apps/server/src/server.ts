import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WorldRepository } from "@agent-world/db";
import { createApp } from "./app.js";
import { describeMode, loadConfig } from "./config.js";
import { LocalRuntime } from "./local-runtime.js";

const config = loadConfig();
if (config.decisionScaleInvalid) {
  console.warn(
    "AGENT_WORLD_DECISION_SCALE is invalid; using 1 (allowed range 0.1–60).",
  );
}
const databasePath = resolve(config.database);
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new WorldRepository(databasePath);
const runtime = new LocalRuntime(repository);
const app = await createApp({ runtime, config });

runtime.start();
const listenUrl = `http://${config.host}:${config.port}`;
await app.listen({ host: config.host, port: config.port });
app.log.info(
  { mode: describeMode(config), url: listenUrl },
  "Agent World listening",
);
if (config.decisionScale > 1 && (config.hasOpenRouterKey || config.liveMpp)) {
  app.log.warn(
    "Decision scale is above 1; spend scales with speed. Cap it with AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS.",
  );
}
