import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  CreateCharacterSchema,
  DirectiveSchema,
  UpdateCharacterSchema,
  UpdateWorldSchema,
} from "@agent-world/shared";
import { WorldRepository } from "@agent-world/db";
import { LocalRuntime } from "./local-runtime.js";

const databasePath = resolve(
  process.env.AGENT_WORLD_DATABASE ?? "./data/agent-world.db",
);
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new WorldRepository(databasePath);
const world = new LocalRuntime(repository);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, {
  origin: process.env.AGENT_WORLD_WEB_ORIGIN?.split(",") ?? true,
  methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
});
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  liveMpp: process.env.AGENT_WORLD_LIVE_MPP === "true",
}));
app.get("/api/state", async () => world.snapshot());

app.post("/api/characters", async (request, reply) => {
  const parsed = CreateCharacterSchema.safeParse(request.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: parsed.error.issues[0]?.message ?? "Invalid character" });
  try {
    const character = await world.createCharacter(parsed.data);
    return reply.code(201).send(character);
  } catch (error) {
    return reply
      .code(409)
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch<{ Params: { name: string } }>(
  "/api/characters/:name",
  async (request, reply) => {
    const parsed = UpdateCharacterSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Invalid update" });
    try {
      world.updateCharacter(request.params.name, parsed.data);
      return { ok: true };
    } catch (error) {
      return reply.code(404).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.post<{ Params: { name: string } }>(
  "/api/characters/:name/directives",
  async (request, reply) => {
    const parsed = DirectiveSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "Invalid direction",
      });
    try {
      world.addDirective(request.params.name, parsed.data);
      return { ok: true };
    } catch (error) {
      return reply.code(404).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.post<{ Params: { name: string } }>(
  "/api/characters/:name/avatar",
  async (request, reply) => {
    try {
      await world.regenerateAvatar(request.params.name);
      return { ok: true };
    } catch (error) {
      return reply.code(404).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.delete<{ Params: { name: string } }>(
  "/api/characters/:name",
  async (request, reply) => {
    try {
      world.deleteCharacter(request.params.name);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(404).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.get("/api/admin", async () => world.adminState());
app.patch("/api/admin", async (request, reply) => {
  const parsed = UpdateWorldSchema.safeParse(request.body);
  if (!parsed.success)
    return reply.code(400).send({
      error: parsed.error.issues[0]?.message ?? "Invalid world settings",
    });
  world.setServerDailyBudgetMicros(parsed.data.serverDailyBudgetMicros);
  return { ok: true };
});
app.post("/api/admin/pause", async (request) => {
  const paused = Boolean((request.body as { paused?: boolean } | null)?.paused);
  world.setSimulationPaused(paused);
  return { ok: true };
});
app.post("/api/admin/reset", async () => {
  world.resetWorld();
  return { ok: true };
});

app.get("/ws", { websocket: true }, (socket) => {
  const unsubscribe = world.subscribe((message) =>
    socket.send(JSON.stringify(message)),
  );
  socket.on("close", () => {
    unsubscribe();
  });
});

app.addHook("onClose", async () => {
  world.stop();
  repository.close();
});

world.start();
const port = Number(process.env.AGENT_WORLD_SERVER_PORT ?? 4310);
await app.listen({ host: "0.0.0.0", port });
