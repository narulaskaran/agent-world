import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WorldRepository } from "@agent-world/db";
import { createApp } from "./app.js";
import { LocalRuntime } from "./local-runtime.js";

const databasePath = resolve(
  process.env.AGENT_WORLD_DATABASE ?? "./data/agent-world.db",
);
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new WorldRepository(databasePath);
const runtime = new LocalRuntime(repository);
const app = await createApp({ runtime });

runtime.start();
const host = process.env.AGENT_WORLD_HOST ?? "127.0.0.1";
const port = Number(process.env.AGENT_WORLD_SERVER_PORT ?? 4310);
await app.listen({ host, port });
