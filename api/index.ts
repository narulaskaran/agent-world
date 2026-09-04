import { neon } from "@neondatabase/serverless";
import {
  CreateCharacterSchema,
  DirectiveSchema,
  WORLD_LOCATIONS,
  UpdateCharacterSchema,
  UpdateWorldSchema,
  nameColor,
} from "../packages/shared/src/index.js";

declare const process: { env: Record<string, string | undefined> };

type Request = {
  method?: string;
  url?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
};
type Response = {
  statusCode: number;
  setHeader(name: string, value: string | number | string[]): void;
  end(body?: string): void;
};
type Row = Record<string, any>;

const sql = neon(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "");
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const id = () => crypto.randomUUID();

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

/** Neon Auth is Better Auth-compatible; the cookie is deliberately never decoded client-side. */
const sessionUserId = async (request: Request): Promise<string | null> => {
  const base = process.env.NEON_AUTH_BASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  const response = await fetch(`${base}/get-session`, {
    headers: {
      accept: "application/json",
      ...(header(request, "cookie")
        ? { cookie: header(request, "cookie")! }
        : {}),
    },
  });
  if (!response.ok) return null;
  const value = (await response.json().catch(() => null)) as Row | null;
  const candidates = [
    value?.user?.id,
    value?.session?.userId,
    value?.data?.user?.id,
    value?.data?.session?.userId,
  ];
  const userId = candidates.find((candidate) => typeof candidate === "string");
  return typeof userId === "string" && userId.length > 0 ? userId : null;
};

const proxyAuth = async (
  path: string,
  request: Request,
  response: Response,
): Promise<void> => {
  const base = process.env.NEON_AUTH_BASE_URL?.replace(/\/$/, "");
  if (!base)
    return send(response, 503, { error: "NEON_AUTH_BASE_URL is not configured" });
  const method = (request.method ?? "GET").toUpperCase();
  const incomingUrl = new URL(request.url ?? "/", "http://vercel.internal");
  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "user-agent"]) {
    const value = header(request, name);
    if (value) headers.set(name, value);
  }
  // This is a same-origin server proxy. Authenticate the server-to-server hop
  // against Neon's own trusted origin instead of forwarding an unregistered
  // browser origin; OAuth callbacks still use explicit absolute URLs.
  headers.set("origin", new URL(base).origin);
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : typeof request.body === "string"
      ? request.body
      : JSON.stringify(request.body ?? {});
  const upstream = await fetch(`${base}${path}${incomingUrl.search}`, {
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
  const getSetCookie = (upstream.headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  const cookies =
    getSetCookie?.call(upstream.headers) ??
    (upstream.headers.get("set-cookie")
      ? [upstream.headers.get("set-cookie")!]
      : []);
  if (cookies.length) response.setHeader("set-cookie", cookies);
  response.end(await upstream.text());
};

const requireUser = async (request: Request, response: Response) => {
  try {
    const userId = await sessionUserId(request);
    if (!userId) {
      send(response, process.env.NEON_AUTH_BASE_URL ? 401 : 503, {
        error: process.env.NEON_AUTH_BASE_URL
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

const isAdmin = (userId: string): boolean =>
  new Set(
    (process.env.AGENT_WORLD_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter(Boolean),
  ).has(userId);

const requireAdmin = async (request: Request, response: Response) => {
  const userId = await requireUser(request, response);
  if (!userId) return null;
  if (!isAdmin(userId)) {
    send(response, 403, { error: "Administrator access required" });
    return null;
  }
  return userId;
};

const hasCronAccess = (request: Request): boolean => {
  const secret = process.env.CRON_SECRET;
  const authorization = header(request, "authorization");
  return Boolean(secret && authorization === `Bearer ${secret}`);
};

const hash = (value: string): number => {
  let result = 0;
  for (const character of value)
    result = (result * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(result);
};

const characterView = (row: Row): Row => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  personality: row.personality,
  model: row.model,
  dailyBudgetMicros: Number(row.daily_budget_micros),
  spentTodayMicros: Number(row.spent_today_micros),
  decisionIntervalSeconds: Number(row.decision_interval_seconds),
  state: row.state,
  x: Number(row.x),
  y: Number(row.y),
  targetX: Number(row.target_x),
  targetY: Number(row.target_y),
  intent: row.intent,
  speech: row.speech ?? null,
  avatarUrl: row.avatar_url ?? null,
  avatarColor: row.avatar_color,
  toolActive: Boolean(row.tool_active),
  updatedAt: Number(row.updated_at),
});

const worldSnapshot = async () => {
  const [stateRows, characterRows, memoryRows, relationshipRows, eventRows] =
    await Promise.all([
      sql`SELECT * FROM world_state WHERE id = 1`,
      sql`SELECT * FROM characters ORDER BY created_at ASC`,
      sql`SELECT * FROM memories WHERE active = true ORDER BY created_at DESC`,
      sql`SELECT * FROM relationships`,
      sql`SELECT id, kind, character_id, character_name, target_character_id, summary, detail, created_at FROM world_events ORDER BY created_at DESC LIMIT 100`,
    ]);
  const state = stateRows[0] as Row | undefined;
  const names = new Map(characterRows.map((row: Row) => [row.id, row.name]));
  const characters = characterRows.map((row: Row) => {
    const memories = memoryRows
      .filter((memory: Row) => memory.character_id === row.id)
      .map((memory: Row) => ({
        id: memory.id,
        kind: memory.kind,
        bullet: memory.bullet,
        subject: memory.subject ?? null,
        confidence: Number(memory.confidence),
        createdAt: Number(memory.created_at),
      }));
    const relationships = relationshipRows
      .filter((relationship: Row) => relationship.character_id === row.id)
      .map((relationship: Row) => ({
        characterId: relationship.other_character_id,
        characterName: names.get(relationship.other_character_id) ?? "Unknown",
        impression: relationship.impression,
        affinity: Number(relationship.affinity),
      }));
    const view = characterView(row);
    return { ...view, memories, relationships };
  });
  return {
    characters,
    events: eventRows.map((event: Row) => ({
      id: event.id,
      kind: event.kind,
      characterId: event.character_id ?? null,
      characterName: event.character_name ?? null,
      targetCharacterId: event.target_character_id ?? null,
      summary: event.summary,
      detail: event.detail ?? null,
      createdAt: Number(event.created_at),
    })),
    locations: WORLD_LOCATIONS,
    simulationPaused: Boolean(state?.simulation_paused),
    serverSpentTodayMicros: Number(state?.server_spent_today_micros ?? 0),
    serverDailyBudgetMicros: Number(state?.server_daily_budget_micros ?? 0),
    budgetDate: state?.budget_date ?? today(),
    connectedViewers: 0,
    generatedAt: now(),
  };
};

const addEvent = async (input: {
  kind: string;
  characterId?: string | null;
  characterName?: string | null;
  targetCharacterId?: string | null;
  summary: string;
  detail?: string | null;
}) => {
  await sql`INSERT INTO world_events (id, kind, character_id, character_name, target_character_id, summary, detail, created_at)
    VALUES (${id()}, ${input.kind}, ${input.characterId ?? null}, ${input.characterName ?? null}, ${input.targetCharacterId ?? null}, ${input.summary}, ${input.detail ?? null}, ${now()})`;
};

const ownedCharacter = async (
  key: string,
  ownerId: string,
): Promise<Row | null> => {
  const rows =
    await sql`SELECT * FROM characters WHERE owner_id = ${ownerId} AND (id = ${key} OR lower(name) = lower(${key})) LIMIT 1`;
  return (rows[0] as Row | undefined) ?? null;
};

const createCharacter = async (
  request: Request,
  response: Response,
  ownerId: string,
) => {
  const parsed = CreateCharacterSchema.safeParse(parseBody(request));
  if (!parsed.success)
    return send(response, 400, {
      error: parsed.error.issues[0]?.message ?? "Invalid character",
    });
  const input = parsed.data;
  const timestamp = now();
  const waypoints = [
    { x: 455, y: 275 },
    { x: 690, y: 275 },
    { x: 455, y: 420 },
    { x: 690, y: 420 },
  ];
  const spawn = waypoints[hash(`${ownerId}:${input.name}`) % waypoints.length]!;
  const characterId = id();
  try {
    await sql`INSERT INTO characters (
      id, owner_id, name, personality, model, daily_budget_micros, spent_today_micros,
      budget_date, decision_interval_seconds, next_decision_at, last_reaction_at, state,
      x, y, target_x, target_y, movement_started_at, movement_arrives_at, intent,
      avatar_color, tool_active, paused, created_at, updated_at
    ) VALUES (
      ${characterId}, ${ownerId}, ${input.name}, ${input.personality}, ${input.model},
      ${input.dailyBudgetMicros}, 0, ${today()}, ${input.decisionIntervalSeconds},
      ${timestamp + 4000}, 0, ${input.firstMission === "meet" ? "waiting" : "active"},
      ${spawn.x}, ${spawn.y}, ${spawn.x}, ${spawn.y}, ${timestamp}, ${timestamp},
      ${input.firstMission === "meet" ? "Hoping someone arrives to meet" : "Getting ready to explore"},
      ${nameColor(input.name)}, false, false, ${timestamp}, ${timestamp}
    )`;
    await addEvent({
      kind: "arrival",
      characterId,
      characterName: input.name,
      summary: `${input.name} arrived in Agent World.`,
      detail: `First mission: ${input.firstMission}`,
    });
    await sql`INSERT INTO character_queue (id, character_id, kind, payload, priority, dedupe_key, not_before, expires_at, status, created_at)
      VALUES (${id()}, ${characterId}, 'first_mission', ${JSON.stringify({ mission: input.firstMission })}::jsonb, 100, 'first_mission', ${timestamp}, ${timestamp + 1800000}, 'pending', ${timestamp})`;
    await runJobs(20);
    return send(
      response,
      201,
      characterView(
        (
          await sql`SELECT * FROM characters WHERE id = ${characterId}`
        )[0] as Row,
      ),
    );
  } catch (error) {
    return send(response, 409, {
      error: errorMessage(error).includes("unique")
        ? "That name or account already has a character"
        : errorMessage(error),
    });
  }
};

const updateCharacter = async (
  key: string,
  request: Request,
  response: Response,
  ownerId: string,
) => {
  const parsed = UpdateCharacterSchema.safeParse(parseBody(request));
  if (!parsed.success)
    return send(response, 400, {
      error: parsed.error.issues[0]?.message ?? "Invalid update",
    });
  const current = await ownedCharacter(key, ownerId);
  if (!current) return send(response, 404, { error: "Character not found" });
  const input = parsed.data;
  const state =
    input.paused === undefined ? null : input.paused ? "paused" : "active";
  const intent =
    input.paused === undefined
      ? null
      : input.paused
        ? "Paused by owner"
        : "Waking up";
  await sql`UPDATE characters SET
    personality = COALESCE(${input.personality ?? null}, personality),
    model = COALESCE(${input.model ?? null}, model),
    daily_budget_micros = COALESCE(${input.dailyBudgetMicros ?? null}, daily_budget_micros),
    decision_interval_seconds = COALESCE(${input.decisionIntervalSeconds ?? null}, decision_interval_seconds),
    paused = COALESCE(${input.paused ?? null}, paused), state = COALESCE(${state}, state), intent = COALESCE(${intent}, intent), updated_at = ${now()}
    WHERE id = ${current.id} AND owner_id = ${ownerId}`;
  await addEvent({
    kind: "owner",
    characterId: current.id,
    characterName: current.name,
    summary: `${current.name}'s owner updated their settings.`,
  });
  send(response, 200, { ok: true });
};

const addDirective = async (
  key: string,
  request: Request,
  response: Response,
  ownerId: string,
) => {
  const parsed = DirectiveSchema.safeParse(parseBody(request));
  if (!parsed.success)
    return send(response, 400, {
      error: parsed.error.issues[0]?.message ?? "Invalid direction",
    });
  const character = await ownedCharacter(key, ownerId);
  if (!character) return send(response, 404, { error: "Character not found" });
  const timestamp = now();
  if (parsed.data.mode === "personality") {
    const personality =
      `${character.personality}\nOwner update: ${parsed.data.text}`.slice(
        0,
        800,
      );
    await sql`UPDATE characters SET personality = ${personality}, updated_at = ${timestamp} WHERE id = ${character.id} AND owner_id = ${ownerId}`;
  } else {
    await sql`INSERT INTO character_queue (id, character_id, kind, payload, priority, not_before, expires_at, status, created_at)
      VALUES (${id()}, ${character.id}, 'owner_directive', ${JSON.stringify({ text: parsed.data.text })}::jsonb, 1000, ${timestamp}, ${timestamp + 1800000}, 'pending', ${timestamp})`;
    await runJobs(20);
  }
  await addEvent({
    kind: "owner",
    characterId: character.id,
    characterName: character.name,
    summary: `${character.name} received a new direction.`,
    detail: parsed.data.text,
  });
  send(response, 200, { ok: true });
};

const deleteCharacter = async (
  key: string,
  request: Request,
  response: Response,
  ownerId: string,
) => {
  const character = await ownedCharacter(key, ownerId);
  if (!character) return send(response, 404, { error: "Character not found" });
  await sql`DELETE FROM conversation_messages WHERE character_id = ${character.id}`;
  await sql`DELETE FROM character_queue WHERE character_id = ${character.id}`;
  await sql`DELETE FROM memories WHERE character_id = ${character.id}`;
  await sql`DELETE FROM relationships WHERE character_id = ${character.id} OR other_character_id = ${character.id}`;
  await sql`DELETE FROM conversations WHERE character_a_id = ${character.id} OR character_b_id = ${character.id}`;
  await sql`DELETE FROM characters WHERE id = ${character.id} AND owner_id = ${ownerId}`;
  await addEvent({
    kind: "system",
    summary: `${character.name} left Agent World.`,
  });
  send(response, 204);
};

const deterministicJob = async (item: Row): Promise<void> => {
  const characterRows =
    await sql`SELECT * FROM characters WHERE id = ${item.character_id}`;
  const character = characterRows[0] as Row | undefined;
  if (!character) return;
  const payload = (
    typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload
  ) as Row;
  const timestamp = now();
  if (item.kind === "first_mission") {
    if (payload.mission === "explore") {
      const locations = [
        { id: "plaza", x: 570, y: 350 },
        { id: "cafe", x: 190, y: 180 },
        { id: "park", x: 900, y: 180 },
        { id: "library", x: 220, y: 540 },
      ];
      const location = locations[hash(character.id) % locations.length]!;
      await sql`UPDATE characters SET x = ${location.x}, y = ${location.y}, target_x = ${location.x}, target_y = ${location.y}, state = 'active', intent = ${`Exploring ${location.id}`}, updated_at = ${timestamp} WHERE id = ${character.id}`;
      await addEvent({
        kind: "movement",
        characterId: character.id,
        characterName: character.name,
        summary: `${character.name} explored ${location.id}.`,
        detail: "deterministic job",
      });
    } else {
      const others =
        await sql`SELECT * FROM characters WHERE id <> ${character.id} AND paused = false ORDER BY created_at ASC LIMIT 1`;
      const other = others[0] as Row | undefined;
      if (!other) {
        await sql`UPDATE characters SET state = 'waiting', intent = 'Waiting for someone new to arrive', updated_at = ${timestamp} WHERE id = ${character.id}`;
        await addEvent({
          kind: "system",
          characterId: character.id,
          characterName: character.name,
          summary: `${character.name} is waiting to meet someone.`,
        });
      } else {
        const conversationId = id();
        const first = `Hello ${other.name}, I’m ${character.name}. Let’s compare what we notice here.`;
        const second = `Nice to meet you, ${character.name}. I’ve been paying attention to the shape of this place.`;
        await sql`INSERT INTO conversations (id, character_a_id, character_b_id, status, message_count, started_at) VALUES (${conversationId}, ${character.id}, ${other.id}, 'active', 2, ${timestamp})`;
        await sql`UPDATE characters SET current_conversation_id = ${conversationId}, state = 'talking', intent = ${`Talking with ${other.name}`}, updated_at = ${timestamp} WHERE id = ${character.id}`;
        await sql`UPDATE characters SET current_conversation_id = ${conversationId}, state = 'talking', intent = ${`Talking with ${character.name}`}, updated_at = ${timestamp} WHERE id = ${other.id}`;
        await sql`INSERT INTO conversation_messages (id, conversation_id, character_id, character_name, turn, text, created_at) VALUES (${id()}, ${conversationId}, ${character.id}, ${character.name}, 1, ${first}, ${timestamp}), (${id()}, ${conversationId}, ${other.id}, ${other.name}, 2, ${second}, ${timestamp})`;
        await addEvent({
          kind: "conversation",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: other.id,
          summary: `${character.name} and ${other.name} started talking.`,
          detail: `conversation:${conversationId}`,
        });
        await addEvent({
          kind: "conversation",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: other.id,
          summary: `${character.name}: ${first}`,
          detail: `conversation:${conversationId}`,
        });
        await addEvent({
          kind: "conversation",
          characterId: other.id,
          characterName: other.name,
          targetCharacterId: character.id,
          summary: `${other.name}: ${second}`,
          detail: `conversation:${conversationId}`,
        });
      }
    }
  } else if (item.kind === "owner_directive") {
    const text = String(payload.text ?? "").slice(0, 280);
    await sql`UPDATE characters SET state = 'active', intent = ${`Following direction: ${text}`.slice(0, 140)}, speech = ${`I’ll focus on this: ${text}`.slice(0, 280)}, speech_expires_at = ${timestamp + 120000}, updated_at = ${timestamp} WHERE id = ${character.id}`;
    await addEvent({
      kind: "conversation",
      characterId: character.id,
      characterName: character.name,
      summary: `${character.name}: I’ll focus on this: ${text}`,
      detail: "deterministic directive response",
    });
  } else if (item.kind === "new_character") {
    await addEvent({
      kind: "system",
      characterId: character.id,
      characterName: character.name,
      targetCharacterId: String(payload.targetCharacterId ?? ""),
      summary: `${character.name} noticed someone new in Agent World.`,
    });
  }
};

const runJobs = async (limit: number): Promise<{ processed: number }> => {
  const stateRows =
    await sql`SELECT simulation_paused FROM world_state WHERE id = 1`;
  if (Boolean((stateRows[0] as Row | undefined)?.simulation_paused))
    return { processed: 0 };
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const timestamp = now();
    await sql`UPDATE character_queue SET status = 'expired' WHERE status = 'pending' AND expires_at <= ${timestamp}`;
    const claimed = await sql`WITH candidate AS (
      SELECT id FROM character_queue WHERE status = 'pending' AND not_before <= ${timestamp} AND expires_at > ${timestamp}
      ORDER BY priority DESC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE character_queue AS queue SET status = 'processing', not_before = ${timestamp + 120000}
      FROM candidate WHERE queue.id = candidate.id RETURNING queue.*`;
    const item = claimed[0] as Row | undefined;
    if (!item) break;
    try {
      await deterministicJob(item);
      await sql`UPDATE character_queue SET status = 'completed' WHERE id = ${item.id} AND status = 'processing'`;
    } catch (error) {
      await sql`UPDATE character_queue SET status = 'completed' WHERE id = ${item.id}`;
      await addEvent({
        kind: "system",
        characterId: item.character_id,
        summary: "A deterministic job failed.",
        detail: errorMessage(error),
      });
    }
  }
  return { processed };
};

const adminState = async () => {
  const [worldRows, queueRows, costRows, leaseRows] = await Promise.all([
    sql`SELECT * FROM world_state WHERE id = 1`,
    sql`SELECT count(*)::int AS count FROM character_queue WHERE status = 'pending'`,
    sql`SELECT id, character_id, category, provider, amount_micros, reserved_micros, status, latency_ms, metadata, budget_date, created_at FROM cost_entries ORDER BY created_at DESC LIMIT 200`,
    sql`SELECT id FROM characters WHERE false`,
  ]);
  return {
    liveMpp: false,
    queueDepth: Number((queueRows[0] as Row | undefined)?.count ?? 0),
    costs: costRows.map((row: Row) => ({
      ...row,
      amount_micros: Number(row.amount_micros),
      reserved_micros: Number(row.reserved_micros),
      created_at: Number(row.created_at),
    })),
    world: worldRows[0] ?? null,
    inFlight: leaseRows.map((row: Row) => row.id),
  };
};

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

export default async function handler(
  request: Request,
  response: Response,
): Promise<void> {
  const origin = header(request, "origin");
  const host = header(request, "x-forwarded-host") ?? header(request, "host");
  const allowedOrigins = new Set(
    (process.env.AGENT_WORLD_WEB_ORIGIN ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
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
  if ((request.method ?? "GET").toUpperCase() === "OPTIONS")
    return send(response, 204);
  const { path, search } = pathFor(request);
  const method = (request.method ?? "GET").toUpperCase();
  try {
    if (path === "/health" && method === "GET") {
      let database = "ok";
      try {
        await sql`SELECT 1`;
      } catch {
        database = "error";
      }
      const auth = process.env.NEON_AUTH_BASE_URL ? "configured" : "missing";
      return send(
        response,
        database === "ok" && auth === "configured" ? 200 : 503,
        {
          ok: database === "ok" && auth === "configured",
          dependencies: { database, auth },
        },
      );
    }
    if (path === "/state" && method === "GET")
      return send(response, 200, await worldSnapshot());
    if (path === "/auth/session" && method === "GET") {
      const userId = await sessionUserId(request);
      if (!userId) return send(response, 200, { viewer: null });
      const owned =
        await sql`SELECT id FROM characters WHERE owner_id = ${userId} LIMIT 1`;
      return send(response, 200, {
        viewer: {
          userId,
          isAdmin: isAdmin(userId),
          characterId: (owned[0] as Row | undefined)?.id ?? null,
        },
      });
    }
    if (path.startsWith("/auth/"))
      return proxyAuth(path.slice("/auth".length), request, response);
    if (path === "/characters" && method === "POST") {
      const ownerId = await requireUser(request, response);
      if (ownerId) return createCharacter(request, response, ownerId);
      return;
    }
    const characterMatch = path.match(
      /^\/characters\/([^/]+)(?:\/(directives|avatar))?$/,
    );
    if (characterMatch) {
      const key = decodeURIComponent(characterMatch[1]!);
      const action = characterMatch[2];
      const ownerId = await requireUser(request, response);
      if (!ownerId) return;
      if (action === "directives" && method === "POST")
        return addDirective(key, request, response, ownerId);
      if (action === "avatar" && method === "POST") {
        const character = await ownedCharacter(key, ownerId);
        if (!character)
          return send(response, 404, { error: "Character not found" });
        await addEvent({
          kind: "system",
          characterId: character.id,
          characterName: character.name,
          summary: `${character.name} is using a fallback pixel avatar.`,
        });
        return send(response, 200, { ok: true });
      }
      if (!action && method === "PATCH")
        return updateCharacter(key, request, response, ownerId);
      if (!action && method === "DELETE")
        return deleteCharacter(key, request, response, ownerId);
    }
    if (path === "/admin" && method === "GET") {
      if (await requireAdmin(request, response))
        return send(response, 200, await adminState());
      return;
    }
    if (path === "/admin" && method === "PATCH") {
      if (!(await requireAdmin(request, response))) return;
      const parsed = UpdateWorldSchema.safeParse(parseBody(request));
      if (!parsed.success)
        return send(response, 400, {
          error: parsed.error.issues[0]?.message ?? "Invalid world settings",
        });
      await sql`UPDATE world_state SET server_daily_budget_micros = ${parsed.data.serverDailyBudgetMicros}, updated_at = ${now()} WHERE id = 1`;
      await addEvent({
        kind: "system",
        summary: `The world budget is now $${(parsed.data.serverDailyBudgetMicros / 1_000_000).toFixed(2)} per day.`,
      });
      return send(response, 200, { ok: true });
    }
    if (path === "/admin/pause" && method === "POST") {
      if (!(await requireAdmin(request, response))) return;
      const paused = Boolean(parseBody(request).paused);
      await sql`UPDATE world_state SET simulation_paused = ${paused}, paused_at = ${paused ? now() : 0}, updated_at = ${now()} WHERE id = 1`;
      await addEvent({
        kind: "system",
        summary: paused ? "The world is paused." : "The world is moving again.",
      });
      return send(response, 200, { ok: true });
    }
    if (path === "/admin/reset" && method === "POST") {
      if (!(await requireAdmin(request, response))) return;
      for (const table of [
        "conversation_messages",
        "character_queue",
        "memories",
        "relationships",
        "conversations",
        "world_events",
        "cost_entries",
        "characters",
      ])
        await sql.query(`DELETE FROM ${table}`);
      await sql`UPDATE world_state SET simulation_paused = false, paused_at = 0, server_spent_today_micros = 0, budget_date = ${today()}, updated_at = ${now()} WHERE id = 1`;
      return send(response, 200, { ok: true });
    }
    if (path === "/jobs/run" && (method === "POST" || method === "GET")) {
      if (!hasCronAccess(request) && !(await requireAdmin(request, response)))
        return;
      const limit = Math.max(
        1,
        Math.min(50, Number(search.get("limit") ?? 20) || 20),
      );
      return send(response, 200, await runJobs(limit));
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, 500, { error: errorMessage(error) });
  }
}
