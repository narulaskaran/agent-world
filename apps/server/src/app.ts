import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  CreateCharacterSchema,
  DirectiveSchema,
  PauseWorldSchema,
  ResetWorldSchema,
  UpdateCharacterSchema,
  UpdateWorldSchema,
} from "@agent-world/shared";
import type { LocalRuntime } from "./local-runtime.js";
import { loadConfig, type WorldConfig } from "./config.js";

export function defaultWebDist(): string {
  return fileURLToPath(new URL("../../web/dist", import.meta.url));
}

export interface CreateAppOptions {
  runtime: LocalRuntime;
  logger?: boolean | { level: string };
  corsOrigin?: string | string[] | boolean;
  webDist?: string;
  config?: WorldConfig;
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const hostName = (host: string): string =>
  host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? host);

/** Loopback variants of an origin, so `localhost` and `127.0.0.1` both work. */
const originVariants = (origin: string): string[] => {
  try {
    const url = new URL(origin);
    if (!LOOPBACK_NAMES.has(url.hostname)) return [url.origin];
    return ["localhost", "127.0.0.1", "[::1]"].map(
      (name) => `${url.protocol}//${name}${url.port ? `:${url.port}` : ""}`,
    );
  } catch {
    return [];
  }
};

/**
 * Admin routes are unauthenticated, so only the local UI may call them.
 * The Host check defeats DNS rebinding; the Origin check stops other sites
 * (including WebSocket upgrades, which CORS does not cover).
 */
export function requestGuard(config: WorldConfig, extraOrigins: string[]) {
  const allowedHosts = new Set(config.allowedHosts);
  if (config.host !== "0.0.0.0" && config.host !== "::")
    allowedHosts.add(config.host.toLowerCase());
  const allowedOrigins = new Set(
    [config.webOrigin, ...extraOrigins].flatMap(originVariants),
  );
  return (request: FastifyRequest): string | null => {
    const host = (request.headers.host ?? "").toLowerCase();
    const name = hostName(host);
    if (
      !LOOPBACK_NAMES.has(name) &&
      !allowedHosts.has(host) &&
      !allowedHosts.has(name)
    )
      return "Host not allowed";
    const origin = request.headers.origin;
    if (origin && origin !== "null") {
      const sameOrigin = originVariants(`http://${host}`).includes(origin);
      if (!sameOrigin && !allowedOrigins.has(origin))
        return "Origin not allowed";
    } else if (origin === "null") {
      return "Origin not allowed";
    }
    if (request.headers["sec-fetch-site"] === "cross-site")
      return "Cross-site request blocked";
    return null;
  };
}

interface Schema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ message: string }> } };
}

function parse<T>(
  schema: Schema<T>,
  body: unknown,
  reply: FastifyReply,
  fallback: string,
): T | undefined {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  void reply
    .code(400)
    .send({ error: parsed.error.issues[0]?.message ?? fallback });
  return undefined;
}

const notFound = (reply: FastifyReply, error: unknown) =>
  reply.code(404).send({
    error: error instanceof Error ? error.message : String(error),
  });

export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  const { runtime } = options;
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    bodyLimit: 64 * 1024,
  });

  const corsOrigin = options.corsOrigin ?? config.webOrigin;
  const guard = requestGuard(
    config,
    typeof corsOrigin === "string"
      ? [corsOrigin]
      : Array.isArray(corsOrigin)
        ? corsOrigin
        : [],
  );
  app.addHook("onRequest", async (request, reply) => {
    const problem = guard(request);
    if (problem) return reply.code(403).send({ error: problem });
  });

  await app.register(cors, {
    origin: corsOrigin,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  });
  await app.register(websocket);

  app.get("/health", async () => {
    const snapshot = runtime.snapshot();
    return {
      ok: true,
      liveMpp: config.liveMpp,
      mode: snapshot.brain,
      decisionScale: snapshot.decisionScale,
      serverDailyBudgetMicros: snapshot.serverDailyBudgetMicros,
    };
  });
  app.get("/api/state", async () => runtime.snapshot());

  app.get<{ Querystring: { since?: string } }>(
    "/api/recap",
    async (request, reply) => {
      const since = Number(request.query.since);
      if (!Number.isFinite(since) || since < 0)
        return reply.code(400).send({ error: "Pass ?since=<epoch ms>" });
      return runtime.recap(since);
    },
  );

  app.get<{ Params: { idOrName: string } }>(
    "/api/characters/:idOrName",
    async (request, reply) => {
      const character = runtime.inspectCharacter(request.params.idOrName);
      if (!character)
        return reply.code(404).send({ error: "Character not found" });
      return { character };
    },
  );

  app.get<{ Params: { idOrName: string } }>(
    "/api/characters/:idOrName/avatar",
    async (request, reply) => {
      const avatar = runtime.avatar(request.params.idOrName);
      if (!avatar) return reply.code(404).send({ error: "No avatar" });
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(avatar);
      if (!match) return reply.redirect(avatar);
      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .type(match[1]!)
        .send(Buffer.from(match[2]!, "base64"));
    },
  );

  app.post("/api/characters", async (request, reply) => {
    const input = parse(
      CreateCharacterSchema,
      request.body,
      reply,
      "Invalid character",
    );
    if (!input) return reply;
    try {
      const character = await runtime.createCharacter(input);
      return reply.code(201).send(character);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.patch<{ Params: { name: string } }>(
    "/api/characters/:name",
    async (request, reply) => {
      const input = parse(
        UpdateCharacterSchema,
        request.body,
        reply,
        "Invalid update",
      );
      if (!input) return reply;
      try {
        runtime.updateCharacter(request.params.name, input);
        return { ok: true };
      } catch (error) {
        return notFound(reply, error);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    "/api/characters/:name/directives",
    async (request, reply) => {
      const input = parse(
        DirectiveSchema,
        request.body,
        reply,
        "Invalid direction",
      );
      if (!input) return reply;
      try {
        runtime.addDirective(request.params.name, input);
        return { ok: true };
      } catch (error) {
        return notFound(reply, error);
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
        return notFound(reply, error);
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
        return notFound(reply, error);
      }
    },
  );

  app.get("/api/admin", async () => runtime.adminState());
  app.patch("/api/admin", async (request, reply) => {
    const input = parse(
      UpdateWorldSchema,
      request.body,
      reply,
      "Invalid world settings",
    );
    if (!input) return reply;
    if (input.serverDailyBudgetMicros !== undefined)
      runtime.setServerDailyBudgetMicros(input.serverDailyBudgetMicros);
    if (input.decisionScale !== undefined)
      runtime.setDecisionScale(input.decisionScale);
    return { ok: true };
  });
  app.post("/api/admin/pause", async (request, reply) => {
    const input = parse(
      PauseWorldSchema,
      request.body,
      reply,
      "Send { paused: boolean }",
    );
    if (!input) return reply;
    runtime.setSimulationPaused(input.paused);
    return { ok: true };
  });
  app.post("/api/admin/reset", async (request, reply) => {
    const input = parse(
      ResetWorldSchema,
      request.body,
      reply,
      'Send { confirm: "reset" }',
    );
    if (!input) return reply;
    runtime.resetWorld();
    return { ok: true };
  });
  app.post("/api/admin/seed", async () => ({
    created: await runtime.seedStarterCast(),
  }));

  app.get("/ws", { websocket: true }, (socket) => {
    const unsubscribe = runtime.subscribe((message) =>
      socket.send(JSON.stringify(message)),
    );
    socket.on("close", () => {
      unsubscribe();
    });
  });

  const webDist = options.webDist ?? defaultWebDist();
  if (existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const path = (request.url.split("?")[0] ?? request.url) || "/";
      if (
        request.method === "GET" &&
        !path.startsWith("/api") &&
        path !== "/ws" &&
        path !== "/health"
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply
        .type("text/plain")
        .send("Client not built. Run pnpm start from the repo root."),
    );
  }

  app.addHook("onClose", async () => {
    await runtime.stop();
    runtime.repository.close();
  });

  return app;
}
