import {
  ArtifactSchema,
  CharacterExportSchema,
  CreateCharacterSchema,
  DirectiveSchema,
  LOCATION_WAYPOINTS,
  MAX_CHARACTERS_PER_USER,
  ReportSchema,
  UpdateCharacterSchema,
  UpdateWorldSchema,
  WORLD_LOCATIONS,
  hashString,
  nameColor,
  type CharacterState,
  type WorldSnapshot,
} from "../../shared/src/index.js";
import { ConflictError, HttpError } from "./errors.js";
import { logEvent, postOperatorAlert, type LogEvent } from "./logging.js";
import {
  addPublicEvent,
  enqueueTick,
  positionAt,
  runAutonomy,
  type AutonomyOptions,
} from "./jobs.js";
import type { CharacterRow, HostedStore } from "./store.js";

export type Request = {
  method?: string;
  url?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
};

export type Response = {
  statusCode: number;
  setHeader(name: string, value: string | number | string[]): void;
  end(body?: string): void;
};

export interface HostedEnv {
  neonAuthBaseUrl?: string;
  cronSecret?: string;
  adminUserIds: string[];
  webOrigins: string[];
  operatorAlertWebhook?: string;
  inviteOnly: boolean;
  inviteUserIds: string[];
  maxCharactersPerUser: number;
  mutationLimit: number;
  mutationWindowMs: number;
  drainLimit: number;
  leaseMs: number;
  maxAttempts: number;
  eventKeep: number;
  eventMaxAgeMs: number;
}

export interface HostedDeps {
  store: HostedStore;
  env: HostedEnv;
  sessionUserId: (request: Request) => Promise<string | null>;
  now: () => number;
  fetch: typeof fetch;
  log?: (event: LogEvent) => void;
  waitUntil?: (task: Promise<unknown>) => void;
}

const header = (request: Request, name: string): string | undefined => {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value;
};

const send = (response: Response, status: number, body?: unknown): void => {
  response.statusCode = status;
  if (body === undefined) return response.end();
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
};

const parseBody = (request: Request): Record<string, unknown> => {
  if (request.body && typeof request.body === "object")
    return request.body as Record<string, unknown>;
  if (typeof request.body === "string" && request.body.trim())
    return JSON.parse(request.body) as Record<string, unknown>;
  return {};
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

const pathFor = (
  request: Request,
): { path: string; search: URLSearchParams } => {
  const url = new URL(request.url ?? "/api/state", "http://vercel.internal");
  const rewrittenPath = url.searchParams.get("path");
  const path = rewrittenPath
    ? `/${rewrittenPath.replace(/^\/+/, "")}`
    : url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return { path, search: url.searchParams };
};

const clientKey = (request: Request): string =>
  header(request, "x-forwarded-for")?.split(",")[0]?.trim() ||
  header(request, "x-real-ip") ||
  "anonymous";

export const parseEnv = (
  env: Record<string, string | undefined>,
): HostedEnv => ({
  neonAuthBaseUrl: env.NEON_AUTH_BASE_URL?.replace(/\/$/, ""),
  cronSecret: env.CRON_SECRET,
  adminUserIds: (env.AGENT_WORLD_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  webOrigins: (env.AGENT_WORLD_WEB_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  operatorAlertWebhook: env.OPERATOR_ALERT_WEBHOOK,
  inviteOnly: env.AGENT_WORLD_INVITE_ONLY === "true",
  inviteUserIds: (env.AGENT_WORLD_INVITE_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  maxCharactersPerUser: Number(env.AGENT_WORLD_MAX_CHARACTERS_PER_USER ?? MAX_CHARACTERS_PER_USER) || MAX_CHARACTERS_PER_USER,
  mutationLimit: Number(env.AGENT_WORLD_MUTATION_LIMIT ?? 30) || 30,
  mutationWindowMs: Number(env.AGENT_WORLD_MUTATION_WINDOW_MS ?? 60_000) || 60_000,
  drainLimit: Number(env.AGENT_WORLD_DRAIN_LIMIT ?? 20) || 20,
  leaseMs: Number(env.AGENT_WORLD_JOB_LEASE_MS ?? 120_000) || 120_000,
  maxAttempts: Number(env.AGENT_WORLD_JOB_MAX_ATTEMPTS ?? 5) || 5,
  eventKeep: Number(env.AGENT_WORLD_EVENT_KEEP ?? 500) || 500,
  eventMaxAgeMs:
    Number(env.AGENT_WORLD_EVENT_MAX_AGE_MS ?? 14 * 24 * 60 * 60 * 1000) ||
    14 * 24 * 60 * 60 * 1000,
});

export const isAdmin = (env: HostedEnv, userId: string): boolean =>
  new Set(env.adminUserIds).has(userId);

export const hasCronAccess = (env: HostedEnv, request: Request): boolean =>
  Boolean(env.cronSecret && header(request, "authorization") === `Bearer ${env.cronSecret}`);

const characterView = (row: CharacterRow, now: number) => {
  const pos = positionAt(row, now);
  const moving = row.state === "moving" && now < row.movementArrivesAt;
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    personality: row.personality,
    model: row.model,
    dailyBudgetMicros: row.dailyBudgetMicros,
    spentTodayMicros: row.spentTodayMicros,
    decisionIntervalSeconds: row.decisionIntervalSeconds,
    state: (moving ? "moving" : row.state === "moving" ? "active" : row.state) as CharacterState,
    x: pos.x,
    y: pos.y,
    targetX: row.targetX,
    targetY: row.targetY,
    intent: row.intent,
    speech: row.speech,
    avatarUrl: row.avatarUrl,
    avatarColor: row.avatarColor,
    toolActive: row.toolActive,
    reputation: row.reputation,
    locationId: row.locationId,
    updatedAt: row.updatedAt,
  };
};

const mayCreateCharacter = (env: HostedEnv, userId: string): boolean =>
  !env.inviteOnly || isAdmin(env, userId) || env.inviteUserIds.includes(userId);

const autonomyOptions = (deps: HostedDeps, limit: number): AutonomyOptions => ({
  now: deps.now,
  limit,
  leaseMs: deps.env.leaseMs,
  maxAttempts: deps.env.maxAttempts,
  eventKeep: deps.env.eventKeep,
  eventMaxAgeMs: deps.env.eventMaxAgeMs,
  log: deps.log,
});

const worldSnapshot = async (
  store: HostedStore,
  now: number,
  viewerCharacterIds: string[],
  admin: boolean,
  connectedViewers: number,
  inviteOnly: boolean,
): Promise<WorldSnapshot> => {
  const [state, characterRows, memoryRows, relationshipRows, eventRows, artifacts] =
    await Promise.all([
      store.getWorldState(),
      store.listCharacters(),
      store.listMemories(),
      store.listRelationships(),
      store.listEvents({
        limit: 100,
        viewerCharacterIds,
        isAdmin: admin,
      }),
      store.listArtifacts(),
    ]);
  const names = new Map(characterRows.map((row) => [row.id, row.name]));
  const characters = characterRows.map((row) => {
    const memories = memoryRows
      .filter((memory) => memory.characterId === row.id)
      .map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        bullet: memory.bullet,
        subject: memory.subject,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
      }));
    const relationships = relationshipRows
      .filter((relationship) => relationship.characterId === row.id)
      .map((relationship) => ({
        characterId: relationship.otherCharacterId,
        characterName: names.get(relationship.otherCharacterId) ?? "Unknown",
        impression: relationship.impression,
        affinity: relationship.affinity,
      }));
    const view = characterView(row, now);
    const { ownerId: _ownerId, ...publicView } = view;
    return { ...publicView, memories, relationships };
  });
  return {
    characters,
    events: eventRows.map((event) => ({
      id: event.id,
      kind: event.kind as WorldSnapshot["events"][number]["kind"],
      characterId: event.characterId,
      characterName: event.characterName,
      targetCharacterId: event.targetCharacterId,
      summary: event.summary,
      detail: event.detail,
      visibility: event.visibility,
      createdAt: event.createdAt,
    })),
    locations: WORLD_LOCATIONS,
    artifacts,
    simulationPaused: state.simulationPaused,
    serverSpentTodayMicros: state.serverSpentTodayMicros,
    serverDailyBudgetMicros: state.serverDailyBudgetMicros,
    budgetDate: state.budgetDate,
    connectedViewers,
    generatedAt: now,
    inviteOnly,
  };
};

const requireUser = async (
  deps: HostedDeps,
  request: Request,
  response: Response,
): Promise<string | null> => {
  try {
    const userId = await deps.sessionUserId(request);
    if (!userId) {
      send(response, deps.env.neonAuthBaseUrl ? 401 : 503, {
        error: deps.env.neonAuthBaseUrl
          ? "Authentication required"
          : "NEON_AUTH_BASE_URL is not configured",
      });
      return null;
    }
    return userId;
  } catch (error) {
    send(response, 503, {
      error: `Authentication unavailable: ${errorMessage(error)}`,
    });
    return null;
  }
};

const requireAdmin = async (
  deps: HostedDeps,
  request: Request,
  response: Response,
): Promise<string | null> => {
  const userId = await requireUser(deps, request, response);
  if (!userId) return null;
  if (!isAdmin(deps.env, userId)) {
    send(response, 403, { error: "Administrator access required" });
    return null;
  }
  return userId;
};

const rateLimitOrReject = async (
  deps: HostedDeps,
  request: Request,
  response: Response,
  userId: string,
): Promise<boolean> => {
  const allowed = await deps.store.hitRateLimit(
    `mutate:${userId}:${clientKey(request)}`,
    deps.env.mutationWindowMs,
    deps.env.mutationLimit,
    deps.now(),
  );
  if (allowed) return true;
  send(response, 429, { error: "Too many requests. Please wait and try again." });
  return false;
};

export async function fetchSessionUserId(
  request: Request,
  baseUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (!baseUrl) return null;
  const response = await fetchImpl(`${baseUrl}/get-session`, {
    headers: {
      accept: "application/json",
      ...(header(request, "cookie") ? { cookie: header(request, "cookie")! } : {}),
    },
  });
  if (!response.ok) return null;
  const value = (await response.json().catch(() => null)) as Record<
    string,
    any
  > | null;
  const candidates = [
    value?.user?.id,
    value?.session?.userId,
    value?.data?.user?.id,
    value?.data?.session?.userId,
  ];
  const userId = candidates.find((candidate) => typeof candidate === "string");
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

const proxyAuth = async (
  deps: HostedDeps,
  path: string,
  request: Request,
  response: Response,
): Promise<void> => {
  const base = deps.env.neonAuthBaseUrl;
  if (!base)
    return send(response, 503, { error: "NEON_AUTH_BASE_URL is not configured" });
  const method = (request.method ?? "GET").toUpperCase();
  const incomingUrl = new URL(request.url ?? "/", "http://vercel.internal");
  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "user-agent"]) {
    const value = header(request, name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", new URL(base).origin);
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});
  const upstream = await deps.fetch(`${base}${path}${incomingUrl.search}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  response.statusCode = upstream.status;
  for (const name of ["content-type", "location", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  const getSetCookie = (
    upstream.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const cookies =
    getSetCookie?.call(upstream.headers) ??
    (upstream.headers.get("set-cookie")
      ? [upstream.headers.get("set-cookie")!]
      : []);
  if (cookies.length) response.setHeader("set-cookie", cookies);
  response.end(await upstream.text());
};

const createCharacterRow = (
  ownerId: string,
  input: {
    name: string;
    personality: string;
    model: string;
    dailyBudgetMicros: number;
    decisionIntervalSeconds: number;
    firstMission: "meet" | "explore";
  },
  now: number,
): CharacterRow => {
  const waypoints = LOCATION_WAYPOINTS.plaza;
  const spawn = waypoints[hashString(`${ownerId}:${input.name}`) % waypoints.length]!;
  return {
    id: crypto.randomUUID(),
    ownerId,
    name: input.name,
    personality: input.personality,
    model: input.model,
    dailyBudgetMicros: input.dailyBudgetMicros,
    spentTodayMicros: 0,
    budgetDate: today(now),
    decisionIntervalSeconds: input.decisionIntervalSeconds,
    nextDecisionAt: now + 4000,
    lastReactionAt: 0,
    state: input.firstMission === "meet" ? "waiting" : "active",
    x: spawn.x,
    y: spawn.y,
    targetX: spawn.x,
    targetY: spawn.y,
    movementStartedAt: now,
    movementArrivesAt: now,
    intent:
      input.firstMission === "meet"
        ? "Hoping someone arrives to meet"
        : "Getting ready to explore",
    speech: null,
    speechExpiresAt: null,
    avatarUrl: null,
    avatarColor: nameColor(input.name),
    toolActive: false,
    paused: false,
    muted: false,
    reputation: 0,
    locationId: "plaza",
    currentConversationId: null,
    createdAt: now,
    updatedAt: now,
  };
};

export function createHandler(deps: HostedDeps) {
  const log = deps.log ?? logEvent;

  return async function handler(
    request: Request,
    response: Response,
  ): Promise<void> {
    const started = deps.now();
    const requestId = crypto.randomUUID();
    const origin = header(request, "origin");
    const host = header(request, "x-forwarded-host") ?? header(request, "host");
    const allowedOrigins = new Set(deps.env.webOrigins);
    if (host) allowedOrigins.add(`https://${host}`);
    if (origin?.startsWith("http://localhost:")) allowedOrigins.add(origin);
    if (origin && allowedOrigins.has(origin))
      response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader(
      "access-control-allow-headers",
      "authorization, content-type, cookie",
    );
    response.setHeader(
      "access-control-allow-methods",
      "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
    );
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    if ((request.method ?? "GET").toUpperCase() === "OPTIONS")
      return send(response, 204);
    const { path, search } = pathFor(request);
    const method = (request.method ?? "GET").toUpperCase();
    try {
      await deps.store.ensureSchema();
      if (path === "/health" && method === "GET") {
        let database = "ok";
        try {
          await deps.store.getWorldState();
        } catch {
          database = "error";
        }
        const auth = deps.env.neonAuthBaseUrl ? "configured" : "missing";
        return send(
          response,
          database === "ok" && auth === "configured" ? 200 : 503,
          {
            ok: database === "ok" && auth === "configured",
            dependencies: { database, auth },
          },
        );
      }

      const viewerId = await deps.sessionUserId(request).catch(() => null);
      const ownedIds = viewerId ? await deps.store.listOwnedIds(viewerId) : [];
      const admin = Boolean(viewerId && isAdmin(deps.env, viewerId));

      if (path === "/state" && method === "GET") {
        const now = deps.now();
        await deps.store.touchPresence(
          `${viewerId ?? "anon"}:${clientKey(request)}`,
          now,
        );
        const dueCharacters = await deps.store.dueCharacterIds(now);
        const dueJobs = await deps.store.countDueJobs(now);
        if (dueCharacters.length > 0 || dueJobs > 0) {
          await runAutonomy(
            deps.store,
            autonomyOptions(deps, Math.min(8, deps.env.drainLimit)),
          ).catch((error) => {
            log({
              level: "error",
              msg: "opportunistic drain failed",
              kind: errorMessage(error),
              requestId,
            });
          });
        }
        const snapshot = await worldSnapshot(
          deps.store,
          deps.now(),
          ownedIds,
          admin,
          await deps.store.countPresence(deps.now() - 20_000),
          deps.env.inviteOnly,
        );
        return send(response, 200, {
          snapshot,
          viewer: viewerId
            ? {
                userId: viewerId,
                isAdmin: admin,
                characterId: ownedIds[0] ?? null,
                characterIds: ownedIds,
              }
            : null,
        });
      }

      if (path === "/auth/session" && method === "GET") {
        if (!viewerId) return send(response, 200, { viewer: null });
        return send(response, 200, {
          viewer: {
            userId: viewerId,
            isAdmin: admin,
            characterId: ownedIds[0] ?? null,
            characterIds: ownedIds,
          },
        });
      }
      if (path.startsWith("/auth/"))
        return proxyAuth(deps, path.slice("/auth".length), request, response);

      if (path === "/characters" && method === "POST") {
        const ownerId = await requireUser(deps, request, response);
        if (!ownerId) return;
        if (!(await rateLimitOrReject(deps, request, response, ownerId))) return;
        if (!mayCreateCharacter(deps.env, ownerId))
          return send(response, 403, {
            error: "Character creation is invite-only right now",
          });
        const parsed = CreateCharacterSchema.safeParse(parseBody(request));
        if (!parsed.success)
          return send(response, 400, {
            error: parsed.error.issues[0]?.message ?? "Invalid character",
          });
        if (
          (await deps.store.countOwned(ownerId)) >= deps.env.maxCharactersPerUser
        )
          return send(response, 409, {
            error: `Accounts may keep up to ${deps.env.maxCharactersPerUser} characters`,
          });
        const now = deps.now();
        const row = createCharacterRow(ownerId, parsed.data, now);
        try {
          await deps.store.transaction(async () => {
            await deps.store.insertCharacter(row);
            await addPublicEvent(deps.store, {
              kind: "arrival",
              characterId: row.id,
              characterName: row.name,
              summary: `${row.name} arrived in Agent World.`,
              detail: `First mission: ${parsed.data.firstMission}`,
              createdAt: now,
            });
            await deps.store.enqueueJob({
              id: crypto.randomUUID(),
              characterId: row.id,
              kind: "first_mission",
              payload: { mission: parsed.data.firstMission },
              priority: 100,
              dedupeKey: "first_mission",
              notBefore: now,
              expiresAt: now + 1_800_000,
              createdAt: now,
            });
            await enqueueTick(deps.store, row.id, row.nextDecisionAt, now);
          });
        } catch (error) {
          if (error instanceof ConflictError)
            return send(response, 409, { error: error.message });
          return send(response, 409, {
            error: errorMessage(error).includes("unique")
              ? "That name or account already has a character"
              : errorMessage(error),
          });
        }
        await runAutonomy(deps.store, autonomyOptions(deps, deps.env.drainLimit));
        const created = await deps.store.getCharacter(row.id);
        return send(
          response,
          201,
          created ? characterView(created, deps.now()) : characterView(row, now),
        );
      }

      if (path === "/characters/import" && method === "POST") {
        const ownerId = await requireUser(deps, request, response);
        if (!ownerId) return;
        if (!(await rateLimitOrReject(deps, request, response, ownerId))) return;
        if (!mayCreateCharacter(deps.env, ownerId))
          return send(response, 403, {
            error: "Character creation is invite-only right now",
          });
        const parsed = CharacterExportSchema.safeParse(parseBody(request));
        if (!parsed.success)
          return send(response, 400, {
            error: parsed.error.issues[0]?.message ?? "Invalid export",
          });
        if (
          (await deps.store.countOwned(ownerId)) >= deps.env.maxCharactersPerUser
        )
          return send(response, 409, {
            error: `Accounts may keep up to ${deps.env.maxCharactersPerUser} characters`,
          });
        const now = deps.now();
        let name = parsed.data.name;
        if (await deps.store.getCharacter(name))
          name = `${parsed.data.name} ${hashString(ownerId + now).toString(36).slice(0, 4)}`.slice(0, 24);
        const row = createCharacterRow(
          ownerId,
          {
            ...parsed.data,
            name,
            dailyBudgetMicros: 500_000,
            decisionIntervalSeconds: 60,
            firstMission: "explore",
          },
          now,
        );
        await deps.store.insertCharacter(row);
        if (parsed.data.memories.length)
          await deps.store.replaceMemories(
            row.id,
            parsed.data.memories.map((memory) => ({
              id: crypto.randomUUID(),
              characterId: row.id,
              kind: memory.kind,
              bullet: memory.bullet,
              subject: memory.subject ?? null,
              confidence: memory.confidence ?? 0.7,
              active: true,
              createdAt: now,
            })),
          );
        await enqueueTick(deps.store, row.id, row.nextDecisionAt, now);
        await addPublicEvent(deps.store, {
          kind: "arrival",
          characterId: row.id,
          characterName: row.name,
          summary: `${row.name} returned from an exported memory.`,
          createdAt: now,
        });
        return send(response, 201, characterView(row, now));
      }

      const characterMatch = path.match(
        /^\/characters\/([^/]+)(?:\/(directives|avatar|export|artifacts|reports))?$/,
      );
      if (characterMatch) {
        const key = decodeURIComponent(characterMatch[1]!);
        const action = characterMatch[2];
        const ownerId = await requireUser(deps, request, response);
        if (!ownerId) return;
        const owned = await deps.store.findOwned(key, ownerId);

        if (action === "export" && method === "GET") {
          if (!owned) return send(response, 404, { error: "Character not found" });
          const memories = (await deps.store.listMemories()).filter(
            (memory) => memory.characterId === owned.id,
          );
          return send(response, 200, {
            version: 1,
            name: owned.name,
            personality: owned.personality,
            model: owned.model,
            memories: memories.map((memory) => ({
              kind: memory.kind,
              bullet: memory.bullet,
              subject: memory.subject,
              confidence: memory.confidence,
            })),
          });
        }

        if (action === "reports" && method === "POST") {
          if (!(await rateLimitOrReject(deps, request, response, ownerId)))
            return;
          const target = await deps.store.getCharacter(key);
          if (!target)
            return send(response, 404, { error: "Character not found" });
          const parsed = ReportSchema.safeParse({
            ...parseBody(request),
            characterId: target.id,
          });
          if (!parsed.success)
            return send(response, 400, {
              error: parsed.error.issues[0]?.message ?? "Invalid report",
            });
          await deps.store.addReport({
            id: crypto.randomUUID(),
            reporterId: ownerId,
            characterId: target.id,
            eventId: parsed.data.eventId ?? null,
            reason: parsed.data.reason,
            status: "open",
            createdAt: deps.now(),
            resolvedAt: null,
            resolverId: null,
          });
          return send(response, 201, { ok: true });
        }

        if (!owned) return send(response, 404, { error: "Character not found" });
        if (!(await rateLimitOrReject(deps, request, response, ownerId))) return;

        if (action === "directives" && method === "POST") {
          const parsed = DirectiveSchema.safeParse(parseBody(request));
          if (!parsed.success)
            return send(response, 400, {
              error: parsed.error.issues[0]?.message ?? "Invalid direction",
            });
          const now = deps.now();
          if (parsed.data.mode === "personality") {
            const personality =
              `${owned.personality}\nOwner update: ${parsed.data.text}`.slice(0, 800);
            await deps.store.updateCharacter(owned.id, {
              personality,
              updatedAt: now,
            });
          } else {
            await deps.store.enqueueJob({
              id: crypto.randomUUID(),
              characterId: owned.id,
              kind: "owner_directive",
              payload: { text: parsed.data.text },
              priority: 1000,
              dedupeKey: null,
              notBefore: now,
              expiresAt: now + 1_800_000,
              createdAt: now,
            });
            await runAutonomy(deps.store, autonomyOptions(deps, deps.env.drainLimit));
          }
          await addPublicEvent(deps.store, {
            kind: "owner",
            characterId: owned.id,
            characterName: owned.name,
            summary: `${owned.name} received a new direction.`,
            detail: null,
            createdAt: now,
          });
          return send(response, 200, { ok: true });
        }

        if (action === "avatar" && method === "POST") {
          await addPublicEvent(deps.store, {
            kind: "system",
            characterId: owned.id,
            characterName: owned.name,
            summary: `${owned.name} is using a fallback pixel avatar.`,
            createdAt: deps.now(),
          });
          return send(response, 200, { ok: true });
        }

        if (action === "artifacts" && method === "POST") {
          const parsed = ArtifactSchema.safeParse(parseBody(request));
          if (!parsed.success)
            return send(response, 400, {
              error: parsed.error.issues[0]?.message ?? "Invalid artifact",
            });
          const now = deps.now();
          await deps.store.addArtifact({
            id: crypto.randomUUID(),
            locationId: owned.locationId ?? "plaza",
            characterId: owned.id,
            characterName: owned.name,
            kind: parsed.data.kind,
            title: parsed.data.title,
            body: parsed.data.body,
            x: owned.x,
            y: owned.y,
            createdAt: now,
          });
          await addPublicEvent(deps.store, {
            kind: "system",
            characterId: owned.id,
            characterName: owned.name,
            summary: `${owned.name} left ${parsed.data.title} in the world.`,
            createdAt: now,
          });
          return send(response, 201, { ok: true });
        }

        if (!action && method === "PATCH") {
          const parsed = UpdateCharacterSchema.safeParse(parseBody(request));
          if (!parsed.success)
            return send(response, 400, {
              error: parsed.error.issues[0]?.message ?? "Invalid update",
            });
          const input = parsed.data;
          const state =
            input.paused === undefined ? undefined : input.paused ? "paused" : "active";
          const intent =
            input.paused === undefined
              ? undefined
              : input.paused
                ? "Paused by owner"
                : "Waking up";
          await deps.store.updateCharacter(owned.id, {
            personality: input.personality ?? owned.personality,
            model: input.model ?? owned.model,
            dailyBudgetMicros: input.dailyBudgetMicros ?? owned.dailyBudgetMicros,
            decisionIntervalSeconds:
              input.decisionIntervalSeconds ?? owned.decisionIntervalSeconds,
            paused: input.paused ?? owned.paused,
            state: state ?? owned.state,
            intent: intent ?? owned.intent,
            updatedAt: deps.now(),
          });
          await addPublicEvent(deps.store, {
            kind: "owner",
            characterId: owned.id,
            characterName: owned.name,
            summary: `${owned.name}'s owner updated their settings.`,
            createdAt: deps.now(),
          });
          return send(response, 200, { ok: true });
        }

        if (!action && method === "DELETE") {
          await deps.store.deleteCharacter(owned.id);
          await addPublicEvent(deps.store, {
            kind: "system",
            summary: `${owned.name} left Agent World.`,
            createdAt: deps.now(),
          });
          return send(response, 204);
        }
      }

      if (path === "/reports" && method === "POST") {
        const userId = await requireUser(deps, request, response);
        if (!userId) return;
        if (!(await rateLimitOrReject(deps, request, response, userId))) return;
        const parsed = ReportSchema.safeParse(parseBody(request));
        if (!parsed.success)
          return send(response, 400, {
            error: parsed.error.issues[0]?.message ?? "Invalid report",
          });
        await deps.store.addReport({
          id: crypto.randomUUID(),
          reporterId: userId,
          characterId: parsed.data.characterId ?? null,
          eventId: parsed.data.eventId ?? null,
          reason: parsed.data.reason,
          status: "open",
          createdAt: deps.now(),
          resolvedAt: null,
          resolverId: null,
        });
        return send(response, 201, { ok: true });
      }

      if (path === "/admin" && method === "GET") {
        if (!(await requireAdmin(deps, request, response))) return;
        const [world, queueDepth, costs, reports, alerts] = await Promise.all([
          deps.store.getWorldState(),
          deps.store.queueDepth(),
          deps.store.listCosts(200),
          deps.store.listReports(),
          deps.store.listAlerts(50),
        ]);
        return send(response, 200, {
          liveMpp: false,
          queueDepth,
          costs,
          world,
          inFlight: [],
          reports,
          alerts,
        });
      }
      if (path === "/admin" && method === "PATCH") {
        if (!(await requireAdmin(deps, request, response))) return;
        const parsed = UpdateWorldSchema.safeParse(parseBody(request));
        if (!parsed.success)
          return send(response, 400, {
            error: parsed.error.issues[0]?.message ?? "Invalid world settings",
          });
        await deps.store.setServerBudget(
          parsed.data.serverDailyBudgetMicros,
          deps.now(),
        );
        await addPublicEvent(deps.store, {
          kind: "system",
          summary: `The world budget is now $${(parsed.data.serverDailyBudgetMicros / 1_000_000).toFixed(2)} per day.`,
          createdAt: deps.now(),
        });
        return send(response, 200, { ok: true });
      }
      if (path === "/admin/pause" && method === "POST") {
        if (!(await requireAdmin(deps, request, response))) return;
        const paused = Boolean(parseBody(request).paused);
        await deps.store.setSimulationPaused(paused, deps.now());
        await addPublicEvent(deps.store, {
          kind: "system",
          summary: paused ? "The world is paused." : "The world is moving again.",
          createdAt: deps.now(),
        });
        return send(response, 200, { ok: true });
      }
      if (path === "/admin/reset" && method === "POST") {
        if (!(await requireAdmin(deps, request, response))) return;
        await deps.store.resetWorld(deps.now());
        return send(response, 200, { ok: true });
      }
      const muteMatch = path.match(/^\/admin\/characters\/([^/]+)\/mute$/);
      if (muteMatch && method === "POST") {
        if (!(await requireAdmin(deps, request, response))) return;
        const target = await deps.store.getCharacter(
          decodeURIComponent(muteMatch[1]!),
        );
        if (!target)
          return send(response, 404, { error: "Character not found" });
        const muted = Boolean(parseBody(request).muted);
        await deps.store.updateCharacter(target.id, {
          muted,
          updatedAt: deps.now(),
        });
        await addPublicEvent(deps.store, {
          kind: "system",
          characterId: target.id,
          characterName: target.name,
          summary: muted
            ? `${target.name} was muted by an operator.`
            : `${target.name} was unmuted by an operator.`,
          createdAt: deps.now(),
        });
        return send(response, 200, { ok: true, muted });
      }
      const hideMatch = path.match(/^\/admin\/events\/([^/]+)\/hide$/);
      if (hideMatch && method === "POST") {
        if (!(await requireAdmin(deps, request, response))) return;
        const hidden = await deps.store.hideEvent(decodeURIComponent(hideMatch[1]!));
        if (!hidden) return send(response, 404, { error: "Event not found" });
        return send(response, 200, { ok: true });
      }
      const resolveMatch = path.match(/^\/admin\/reports\/([^/]+)\/resolve$/);
      if (resolveMatch && method === "POST") {
        const adminId = await requireAdmin(deps, request, response);
        if (!adminId) return;
        await deps.store.resolveReport(
          decodeURIComponent(resolveMatch[1]!),
          adminId,
          deps.now(),
        );
        return send(response, 200, { ok: true });
      }

      if (path === "/jobs/run" && (method === "POST" || method === "GET")) {
        if (!hasCronAccess(deps.env, request) && !(await requireAdmin(deps, request, response)))
          return;
        const limit = Math.max(
          1,
          Math.min(50, Number(search.get("limit") ?? deps.env.drainLimit) || 20),
        );
        const result = await runAutonomy(deps.store, autonomyOptions(deps, limit));
        if (result.recovered > 0) {
          const alert = {
            level: "alert" as const,
            msg: "stale jobs recovered",
            processed: result.recovered,
            path,
            requestId,
          };
          log(alert);
          await deps.store.addAlert({
            id: crypto.randomUUID(),
            level: "alert",
            kind: "stale_jobs",
            summary: `Recovered ${result.recovered} stale jobs`,
            detail: null,
            createdAt: deps.now(),
          });
          await postOperatorAlert(
            deps.env.operatorAlertWebhook,
            alert,
            deps.fetch,
          );
        }
        return send(response, 200, result);
      }

      send(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpError)
        return send(response, error.status, { error: error.message });
      log({
        level: "error",
        msg: "unhandled hosted handler error",
        path,
        method,
        requestId,
        kind: errorMessage(error),
        durationMs: deps.now() - started,
      });
      await postOperatorAlert(
        deps.env.operatorAlertWebhook,
        {
          level: "alert",
          msg: "unhandled hosted handler error",
          path,
          method,
        },
        deps.fetch,
      ).catch(() => undefined);
      send(response, 500, { error: errorMessage(error) });
    }
  };
}
