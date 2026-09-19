import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  CreateCharacterSchema,
  DirectiveSchema,
  UpdateCharacterSchema,
  UpdateWorldSchema,
} from "@agent-world/shared";
import type { LocalRuntime } from "./local-runtime.js";

export interface CreateAppOptions {
  runtime: LocalRuntime;
  logger?: boolean | { level: string };
  corsOrigin?: string | string[] | boolean;
}

export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  const { runtime } = options;
  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
  });

  await app.register(cors, {
    origin:
      options.corsOrigin ??
      process.env.AGENT_WORLD_WEB_ORIGIN?.split(",") ??
      true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  });
  await app.register(websocket);

  app.get("/health", async () => ({
    ok: true,
    liveMpp: process.env.AGENT_WORLD_LIVE_MPP === "true",
  }));
  app.get("/api/state", async () => runtime.snapshot());

  app.get<{ Params: { idOrName: string } }>(
    "/api/characters/:idOrName",
    async (request, reply) => {
      const character = runtime.inspectCharacter(request.params.idOrName);
      if (!character)
        return reply.code(404).send({ error: "Character not found" });
      return { character };
    },
  );

  app.post("/api/characters", async (request, reply) => {
    const parsed = CreateCharacterSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({
          error: parsed.error.issues[0]?.message ?? "Invalid character",
        });
    try {
      const character = await runtime.createCharacter(parsed.data);
      return reply.code(201).send(character);
    } catch (error) {
      return reply
        .code(409)
        .send({
          error: error instanceof Error ? error.message : String(error),
        });
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
        runtime.updateCharacter(request.params.name, parsed.data);
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
        runtime.addDirective(request.params.name, parsed.data);
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
        await runtime.regenerateAvatar(request.params.name);
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
        runtime.deleteCharacter(request.params.name);
        return reply.code(204).send();
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get("/api/admin", async () => runtime.adminState());
  app.patch("/api/admin", async (request, reply) => {
    const parsed = UpdateWorldSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "Invalid world settings",
      });
    runtime.setServerDailyBudgetMicros(parsed.data.serverDailyBudgetMicros);
    return { ok: true };
  });
  app.post("/api/admin/pause", async (request) => {
    const paused = Boolean(
      (request.body as { paused?: boolean } | null)?.paused,
    );
    runtime.setSimulationPaused(paused);
    return { ok: true };
  });
  app.post("/api/admin/reset", async () => {
    runtime.resetWorld();
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const unsubscribe = runtime.subscribe((message) =>
      socket.send(JSON.stringify(message)),
    );
    socket.on("close", () => {
      unsubscribe();
    });
  });

  app.addHook("onClose", async () => {
    runtime.stop();
    runtime.repository.close();
  });

  return app;
}
