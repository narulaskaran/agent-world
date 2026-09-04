import {
  LOCATION_WAYPOINTS,
  WORLD_LOCATIONS,
  hashString,
  locationAtPoint,
  type WorldLocationId,
} from "../../shared/src/index.js";
import { logEvent } from "./logging.js";
import type { CharacterRow, HostedStore, QueueJob } from "./store.js";

export interface AutonomyOptions {
  now: () => number;
  limit: number;
  leaseMs: number;
  maxAttempts: number;
  eventKeep: number;
  eventMaxAgeMs: number;
  log?: typeof logEvent;
}

const QUEUE_EXPIRY_MS = 30 * 60_000;
const MOVE_SPEED_PER_SECOND = 92;
const newId = () => crypto.randomUUID();

export function positionAt(
  character: CharacterRow,
  now: number,
): { x: number; y: number } {
  if (
    character.movementArrivesAt <= character.movementStartedAt ||
    now >= character.movementArrivesAt
  )
    return { x: character.targetX, y: character.targetY };
  if (now <= character.movementStartedAt)
    return { x: character.x, y: character.y };
  const progress =
    (now - character.movementStartedAt) /
    (character.movementArrivesAt - character.movementStartedAt);
  return {
    x: character.x + (character.targetX - character.x) * progress,
    y: character.y + (character.targetY - character.y) * progress,
  };
}

const settlePosition = async (
  store: HostedStore,
  character: CharacterRow,
  now: number,
): Promise<void> => {
  const arrived = now >= character.movementArrivesAt;
  const pos = positionAt(character, now);
  const patch: Partial<CharacterRow> = {
    x: arrived ? character.targetX : pos.x,
    y: arrived ? character.targetY : pos.y,
    updatedAt: now,
  };
  if (arrived && character.state === "moving") patch.state = "active";
  if (
    patch.x === character.x &&
    patch.y === character.y &&
    patch.state === undefined
  )
    return;
  await store.updateCharacter(character.id, patch);
  Object.assign(character, patch);
};

const startMovement = async (
  store: HostedStore,
  character: CharacterRow,
  dest: { x: number; y: number },
  now: number,
  intent: string,
  locationId: WorldLocationId,
): Promise<void> => {
  await settlePosition(store, character, now);
  const duration = Math.max(
    800,
    Math.round(
      (Math.hypot(dest.x - character.x, dest.y - character.y) /
        MOVE_SPEED_PER_SECOND) *
        1000,
    ),
  );
  const patch: Partial<CharacterRow> = {
    targetX: dest.x,
    targetY: dest.y,
    movementStartedAt: now,
    movementArrivesAt: now + duration,
    locationId,
    state: "moving",
    intent,
    updatedAt: now,
  };
  await store.updateCharacter(character.id, patch);
  Object.assign(character, patch);
};

export async function enqueueTick(
  store: HostedStore,
  characterId: string,
  notBefore: number,
  now: number,
): Promise<string | null> {
  return store.enqueueJob({
    id: newId(),
    characterId,
    kind: "tick",
    payload: {},
    priority: 10,
    dedupeKey: "tick",
    notBefore,
    expiresAt: notBefore + QUEUE_EXPIRY_MS,
    createdAt: now,
  });
}

const waypointFor = (
  locationId: WorldLocationId,
  seed: string,
): { x: number; y: number } => {
  const points = LOCATION_WAYPOINTS[locationId] ?? LOCATION_WAYPOINTS.plaza;
  return points[hashString(seed) % points.length] ?? points[0]!;
};

export async function addPublicEvent(
  store: HostedStore,
  input: {
    kind: string;
    summary: string;
    characterId?: string | null;
    characterName?: string | null;
    targetCharacterId?: string | null;
    detail?: string | null;
    visibility?: "public" | "private";
    conversationId?: string | null;
    createdAt: number;
  },
): Promise<void> {
  await store.addEvent({
    id: newId(),
    kind: input.kind,
    characterId: input.characterId ?? null,
    characterName: input.characterName ?? null,
    targetCharacterId: input.targetCharacterId ?? null,
    summary: input.summary,
    detail: input.detail ?? null,
    visibility: input.visibility ?? "public",
    hidden: false,
    conversationId: input.conversationId ?? null,
    createdAt: input.createdAt,
  });
}

const bumpRelationship = async (
  store: HostedStore,
  left: CharacterRow,
  right: CharacterRow,
  impression: string,
  now: number,
) => {
  const existing = (await store.listRelationships()).find(
    (row) => row.characterId === left.id && row.otherCharacterId === right.id,
  );
  const affinity = Math.min(100, (existing?.affinity ?? 0) + 2);
  await store.upsertRelationship({
    characterId: left.id,
    otherCharacterId: right.id,
    impression,
    affinity,
    updatedAt: now,
  });
  await store.updateCharacter(left.id, {
    reputation: left.reputation + 2,
    updatedAt: now,
  });
  left.reputation += 2;
};

const startConversation = async (
  store: HostedStore,
  members: CharacterRow[],
  now: number,
  privateSpeech: boolean,
) => {
  const [first, second, ...rest] = members;
  if (!first || !second) return;
  const conversationId = newId();
  const all = [first, second, ...rest];
  await store.insertConversation(
    {
      id: conversationId,
      characterAId: first.id,
      characterBId: second.id,
      status: "active",
      messageCount: all.length,
      visibility: privateSpeech ? "private" : "public",
      locationId: first.locationId,
      startedAt: now,
    },
    all.map((member) => member.id),
  );
  const names = all.map((member) => member.name).join(", ");
  await addPublicEvent(store, {
    kind: "conversation",
    characterId: first.id,
    characterName: first.name,
    targetCharacterId: second.id,
    summary:
      all.length > 2
        ? `${names} gathered for a group conversation.`
        : `${first.name} and ${second.name} started talking.`,
    detail: `conversation:${conversationId}`,
    createdAt: now,
  });
  for (const [index, speaker] of all.entries()) {
    const others = all
      .filter((member) => member.id !== speaker.id)
      .map((member) => member.name)
      .join(" and ");
    const text = `Hello ${others}, I’m ${speaker.name}.`;
    await store.addConversationMessage({
      id: newId(),
      conversationId,
      characterId: speaker.id,
      characterName: speaker.name,
      turn: index + 1,
      text,
      createdAt: now,
    });
    await addPublicEvent(store, {
      kind: "conversation",
      characterId: speaker.id,
      characterName: speaker.name,
      targetCharacterId: all[index === 0 ? 1 : 0]?.id ?? null,
      summary: `${speaker.name}: ${text}`,
      detail: `conversation:${conversationId}`,
      visibility: "private",
      conversationId,
      createdAt: now,
    });
    await store.updateCharacter(speaker.id, {
      currentConversationId: conversationId,
      state: "talking",
      intent: `Talking with ${others}`,
      speech: text,
      speechExpiresAt: now + 120_000,
      updatedAt: now,
    });
  }
  for (const left of all) {
    for (const right of all) {
      if (left.id === right.id) continue;
      await bumpRelationship(
        store,
        left,
        right,
        `Met during a ${all.length > 2 ? "group" : "quiet"} conversation.`,
        now,
      );
    }
  }
};

const executeTick = async (
  store: HostedStore,
  character: CharacterRow,
  now: number,
): Promise<void> => {
  if (character.paused || character.muted) return;
  await settlePosition(store, character, now);
  const others = (await store.listCharacters()).filter(
    (row) => row.id !== character.id && !row.paused && !row.muted,
  );
  const here = others.filter(
    (row) =>
      row.locationId &&
      row.locationId === character.locationId &&
      row.locationId !== null,
  );
  const roll = hashString(`${character.id}:${now}`) % 5;
  if (here.length >= 2 && roll === 0) {
    await startConversation(store, [character, ...here.slice(0, 3)], now, true);
    return;
  }
  if (here.length === 1 && roll <= 1) {
    await startConversation(store, [character, here[0]!], now, true);
    return;
  }
  await settlePosition(store, character, now);
  if (roll === 2) {
    const location =
      WORLD_LOCATIONS[hashString(`${character.id}:inspect:${now}`) % WORLD_LOCATIONS.length]!;
    const point = waypointFor(location.id, `${character.id}:inspect`);
    await startMovement(
      store,
      character,
      point,
      now,
      `Looking around ${location.name}`,
      location.id,
    );
    await store.addMemory({
      id: newId(),
      characterId: character.id,
      kind: "fact",
      bullet: `Noticed ${location.description}`,
      subject: location.id,
      confidence: 0.7,
      active: true,
      createdAt: now,
    });
    await addPublicEvent(store, {
      kind: "memory",
      characterId: character.id,
      characterName: character.name,
      summary: `${character.name} studied ${location.name}.`,
      createdAt: now,
    });
    return;
  }
  if (roll === 3) {
    const here = positionAt(character, now);
    const location = locationAtPoint(here.x, here.y) ?? WORLD_LOCATIONS[0]!;
    await store.addArtifact({
      id: newId(),
      locationId: location.id,
      characterId: character.id,
      characterName: character.name,
      kind: "note",
      title: `From ${character.name}`,
      body: `Left behind while ${character.intent.toLowerCase()}.`,
      x: here.x,
      y: here.y,
      createdAt: now,
    });
    await addPublicEvent(store, {
      kind: "system",
      characterId: character.id,
      characterName: character.name,
      summary: `${character.name} left something in ${location.name}.`,
      createdAt: now,
    });
    return;
  }
  const location =
    WORLD_LOCATIONS[hashString(`${character.id}:walk:${now}`) % WORLD_LOCATIONS.length]!;
  const point = waypointFor(location.id, `${character.id}:${now}`);
  await startMovement(
    store,
    character,
    point,
    now,
    `Exploring ${location.name}`,
    location.id,
  );
  await addPublicEvent(store, {
    kind: "movement",
    characterId: character.id,
    characterName: character.name,
    summary: `${character.name} wandered to ${location.name}.`,
    detail: "deterministic tick",
    createdAt: now,
  });
};

export async function executeJob(
  store: HostedStore,
  job: QueueJob,
  now: number,
): Promise<void> {
  const character = await store.getCharacter(job.characterId);
  if (!character) return;
  const payload = job.payload;
  if (job.kind === "first_mission") {
    if (payload.mission === "explore") {
      const location =
        WORLD_LOCATIONS[hashString(character.id) % WORLD_LOCATIONS.length]!;
      const point = waypointFor(location.id, character.id);
      await startMovement(
        store,
        character,
        point,
        now,
        `Exploring ${location.name}`,
        location.id,
      );
      await addPublicEvent(store, {
        kind: "movement",
        characterId: character.id,
        characterName: character.name,
        summary: `${character.name} explored ${location.name}.`,
        detail: "deterministic job",
        createdAt: now,
      });
    } else {
      const other = (await store.listCharacters()).find(
        (row) => row.id !== character.id && !row.paused,
      );
      if (!other) {
        await store.updateCharacter(character.id, {
          state: "waiting",
          intent: "Waiting for someone new to arrive",
          updatedAt: now,
        });
        await addPublicEvent(store, {
          kind: "system",
          characterId: character.id,
          characterName: character.name,
          summary: `${character.name} is waiting to meet someone.`,
          createdAt: now,
        });
      } else {
        await startConversation(store, [character, other], now, true);
      }
    }
    return;
  }
  if (job.kind === "owner_directive") {
    const text = String(payload.text ?? "").slice(0, 280);
    await store.updateCharacter(character.id, {
      state: "active",
      intent: `Following direction: ${text}`.slice(0, 140),
      speech: `I’ll focus on this: ${text}`.slice(0, 280),
      speechExpiresAt: now + 120_000,
      updatedAt: now,
    });
    await addPublicEvent(store, {
      kind: "conversation",
      characterId: character.id,
      characterName: character.name,
      summary: `${character.name}: I’ll focus on this: ${text}`,
      detail: "deterministic directive response",
      createdAt: now,
    });
    return;
  }
  if (job.kind === "tick") {
    await executeTick(store, character, now);
    const nextAt = now + character.decisionIntervalSeconds * 1000;
    await store.updateCharacter(character.id, {
      nextDecisionAt: nextAt,
      updatedAt: now,
    });
    await store.enqueueJob({
      id: newId(),
      characterId: character.id,
      kind: "tick",
      payload: {},
      priority: 10,
      dedupeKey: "tick",
      notBefore: nextAt,
      expiresAt: nextAt + QUEUE_EXPIRY_MS,
      createdAt: now,
    });
  }
}

export async function scheduleDueTicks(
  store: HostedStore,
  now: number,
): Promise<number> {
  const due = await store.dueCharacterIds(now);
  let enqueued = 0;
  for (const characterId of due) {
    const id = await enqueueTick(store, characterId, now, now);
    if (id) enqueued += 1;
  }
  return enqueued;
}

export async function runAutonomy(
  store: HostedStore,
  options: AutonomyOptions,
): Promise<{ processed: number; pendingDue: number; recovered: number }> {
  const now = options.now();
  const log = options.log ?? logEvent;
  await store.ensureSchema();
  const world = await store.getWorldState();
  const recovered = await store.recoverStaleJobs(now);
  await store.expireJobs(now);
  await store.pruneEvents(now, options.eventKeep, options.eventMaxAgeMs);
  if (world.simulationPaused) {
    return { processed: 0, pendingDue: await store.countDueJobs(now), recovered };
  }
  await scheduleDueTicks(store, now);
  let processed = 0;
  for (; processed < options.limit; processed += 1) {
    const job = await store.claimNextJob(now, options.leaseMs);
    if (!job) break;
    try {
      await executeJob(store, job, now);
      await store.completeJob(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.failJob(job.id, message, now, options.maxAttempts);
      log({
        level: "error",
        msg: "deterministic job failed",
        jobId: job.id,
        characterId: job.characterId,
        kind: job.kind,
      });
    }
  }
  return {
    processed,
    pendingDue: await store.countDueJobs(now),
    recovered,
  };
}
