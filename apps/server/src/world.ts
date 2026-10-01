import type {
  CreateCharacterInput,
  DirectiveInput,
  UpdateCharacterInput,
  WorldEvent,
  WorldLocationId,
  WorldRecap,
  WorldSnapshot,
} from "@agent-world/shared";
import {
  BUDGET_SLEEP_INTENT,
  LOCATION_WAYPOINTS,
  WORLD_HEIGHT,
  WORLD_LOCATIONS,
  WORLD_WIDTH,
  locationAtPoint,
  locationName,
  nameColor,
  placeInSentence,
} from "@agent-world/shared";
import type { CharacterRow, WorldStore } from "@agent-world/db";
import {
  BudgetExhaustedError,
  PaidServices,
  type AgentContext,
  type AgentDecision,
} from "./services.js";
import { DEFAULT_REACTION_COOLDOWN_MS, decisionDelayMs } from "./config.js";
import {
  conversationOpener,
  inspectionDetail,
  type Random,
} from "./deterministic.js";

const MOVE_SPEED_PER_SECOND = 92;
const CONVERSATION_DISTANCE = 78;
const CONVERSATION_SPACING = 64;
export const CONVERSATION_LIMIT = 20;
const CONVERSATION_MAX_MS = 10 * 60_000;
const CONVERSATION_RESTART_COOLDOWN_MS = 2 * 60_000;
const QUEUE_EXPIRY_MS = 30 * 60_000;
const TURN_RETRY_MS = 3_000;
const DIRECTIVE_RETRY_MS = 2_000;
const MAX_TURN_ATTEMPTS = 2;
const PERSONALITY_LIMIT = 800;
const OWNER_UPDATE_PREFIX = "\nOwner update: ";
/** Queue kinds a character handles while it is in a conversation. */
const CONVERSATION_KINDS = ["conversation_turn", "owner_directive"];

const CHARACTER_BOUNDS = {
  left: 45,
  right: WORLD_WIDTH - 45,
  top: 90,
  bottom: WORLD_HEIGHT - 90,
};
const clampPosition = (position: { x: number; y: number }) => ({
  x: Math.max(
    CHARACTER_BOUNDS.left,
    Math.min(CHARACTER_BOUNDS.right, position.x),
  ),
  y: Math.max(
    CHARACTER_BOUNDS.top,
    Math.min(CHARACTER_BOUNDS.bottom, position.y),
  ),
});

const distance = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): number => Math.hypot(a.x - b.x, a.y - b.y);

const event = (input: Omit<WorldEvent, "id" | "createdAt">): WorldEvent => ({
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  ...input,
});

const turnKey = (conversationId: string) => `turn:${conversationId}`;

export const isBudgetSleeping = (character: CharacterRow) =>
  character.state === "sleeping" && character.intent === BUDGET_SLEEP_INTENT;

/** Free to be pulled into a new conversation right now. */
export const isAvailableForConversation = (character: CharacterRow) =>
  !character.paused &&
  character.state !== "sleeping" &&
  character.state !== "paused" &&
  !character.currentConversationId;

/** Keeps the base personality and as many of the newest owner updates as fit. */
export function appendPersonalityUpdate(
  personality: string,
  update: string,
): string {
  const [base = "", ...updates] = personality.split(OWNER_UPDATE_PREFIX);
  updates.push(update.trim());
  const join = (items: string[]) => [base, ...items].join(OWNER_UPDATE_PREFIX);
  while (updates.length > 1 && join(updates).length > PERSONALITY_LIMIT)
    updates.shift();
  const joined = join(updates);
  if (joined.length <= PERSONALITY_LIMIT) return joined;
  const tail = `${OWNER_UPDATE_PREFIX}${updates[0]}`.slice(
    0,
    PERSONALITY_LIMIT - 10,
  );
  return `${base.slice(0, PERSONALITY_LIMIT - tail.length)}${tail}`;
}

const STARTER_CAST: CreateCharacterInput[] = [
  {
    name: "Juniper",
    personality:
      "Playful and observant, always collecting unusual stories and asking one question too many.",
    model: "z-ai/glm-5.3-flash",
    dailyBudgetMicros: 250_000,
    decisionIntervalSeconds: 60,
    firstMission: "meet",
  },
  {
    name: "Moss",
    personality:
      "Quiet, patient and slightly obsessed with tiny gardens; happiest in the park.",
    model: "z-ai/glm-5.3-flash",
    dailyBudgetMicros: 250_000,
    decisionIntervalSeconds: 60,
    firstMission: "explore",
  },
  {
    name: "Tinker",
    personality:
      "Restless maker who leaves notes and odd little objects everywhere, curious what others will make of them.",
    model: "z-ai/glm-5.3-flash",
    dailyBudgetMicros: 250_000,
    decisionIntervalSeconds: 60,
    firstMission: "explore",
  },
];

export interface WorldEngineOptions {
  /** Applied at construction; the stored world speed is used afterwards. */
  decisionScale?: number;
  reactionCooldownMs?: number;
  random?: Random;
}

export class WorldEngine {
  private readonly services: PaidServices;
  private readonly reactionCooldownMs: number;
  private readonly random: Random;

  constructor(
    readonly repository: WorldStore,
    private readonly changed: () => void = () => {},
    services?: PaidServices,
    options: WorldEngineOptions = {},
  ) {
    this.services = services ?? new PaidServices(repository);
    this.reactionCooldownMs =
      options.reactionCooldownMs ?? DEFAULT_REACTION_COOLDOWN_MS;
    this.random = options.random ?? Math.random;
    if (options.decisionScale !== undefined)
      repository.setDecisionScale(options.decisionScale);
    this.recoverOffMapCharacters();
  }

  private scale(): number {
    return this.repository.getWorldState().decisionScale;
  }

  private decisionDelay(intervalSeconds: number): number {
    return decisionDelayMs(intervalSeconds, this.scale());
  }

  /** Conversation pace and reaction cooldown follow the world speed. */
  private reactionDelay(): number {
    return Math.round(this.reactionCooldownMs / this.scale());
  }

  private recoverOffMapCharacters(): void {
    const now = Date.now();
    for (const character of this.repository.listCharacterRows()) {
      const current = this.repository.positionAt(character, now);
      const boundedCurrent = clampPosition(current);
      const boundedTarget = clampPosition({
        x: character.targetX,
        y: character.targetY,
      });
      if (
        current.x === boundedCurrent.x &&
        current.y === boundedCurrent.y &&
        character.targetX === boundedTarget.x &&
        character.targetY === boundedTarget.y
      )
        continue;
      this.repository.updateCharacter(character.id, {
        x: boundedCurrent.x,
        y: boundedCurrent.y,
        targetX: boundedTarget.x,
        targetY: boundedTarget.y,
        movementStartedAt: now,
        movementArrivesAt: now,
        state: character.state === "moving" ? "active" : character.state,
      });
    }
  }

  private startMovement(
    characterId: string,
    targetX: number,
    targetY: number,
    intent: string,
  ): number | null {
    const target = clampPosition({ x: targetX, y: targetY });
    return this.repository.startMovement(
      characterId,
      target.x,
      target.y,
      MOVE_SPEED_PER_SECOND,
      intent,
    );
  }

  private moveToLocation(
    characterId: string,
    locationId: WorldLocationId,
    intent: string,
  ): number | null {
    const waypoints = LOCATION_WAYPOINTS[locationId];
    const target =
      waypoints[Math.floor(this.random() * waypoints.length)] ?? waypoints[0]!;
    return this.startMovement(
      characterId,
      target.x + (this.random() - 0.5) * 22,
      target.y + (this.random() - 0.5) * 16,
      intent,
    );
  }

  private moveNextTo(
    characterId: string,
    otherId: string,
    intent: string,
  ): number | null {
    const character = this.repository.getCharacter(characterId);
    const other = this.repository.getCharacter(otherId);
    if (!character || !other) return null;
    const characterPosition = this.repository.positionAt(character);
    const otherPosition = this.repository.positionAt(other);
    const dx = characterPosition.x - otherPosition.x;
    const dy = characterPosition.y - otherPosition.y;
    const currentDistance = Math.hypot(dx, dy);
    const directionX = currentDistance > 0 ? dx / currentDistance : 1;
    const directionY = currentDistance > 0 ? dy / currentDistance : 0;
    return this.startMovement(
      character.id,
      otherPosition.x + directionX * CONVERSATION_SPACING,
      otherPosition.y + directionY * CONVERSATION_SPACING,
      intent,
    );
  }

  snapshot(): WorldSnapshot {
    const state = this.repository.getWorldState();
    return {
      characters: this.repository.listPublicCharacters(),
      events: this.repository.listEvents(),
      locations: WORLD_LOCATIONS,
      artifacts: this.repository.listArtifacts(),
      simulationPaused: state.simulationPaused,
      serverSpentTodayMicros: state.serverSpentTodayMicros,
      serverDailyBudgetMicros: state.serverDailyBudgetMicros,
      budgetDate: state.budgetDate,
      decisionScale: state.decisionScale,
      brain: this.services.brain(),
      generatedAt:
        state.simulationPaused && state.pausedAt > 0
          ? state.pausedAt
          : Date.now(),
    };
  }

  recap(since: number): WorldRecap {
    return this.repository.recap(since);
  }

  async createCharacter(input: CreateCharacterInput) {
    if (this.repository.getCharacter(input.name))
      throw new Error("That name already lives in Agent World");
    const now = Date.now();
    const plazaWaypoints = LOCATION_WAYPOINTS.plaza;
    const spawn =
      plazaWaypoints[Math.floor(this.random() * plazaWaypoints.length)] ??
      plazaWaypoints[0]!;
    const id = crypto.randomUUID();
    const x = spawn.x + (this.random() - 0.5) * 24;
    const y = spawn.y + (this.random() - 0.5) * 18;
    this.repository.createCharacter({
      id,
      name: input.name,
      personality: input.personality,
      model: input.model,
      dailyBudgetMicros: input.dailyBudgetMicros,
      spentTodayMicros: 0,
      budgetDate: this.repository.getWorldState().budgetDate,
      decisionIntervalSeconds: input.decisionIntervalSeconds,
      nextDecisionAt: now + this.decisionDelay(4),
      lastReactionAt: 0,
      state: input.firstMission === "meet" ? "waiting" : "active",
      x,
      y,
      targetX: x,
      targetY: y,
      movementStartedAt: now,
      movementArrivesAt: now,
      intent:
        input.firstMission === "meet"
          ? "Hoping someone arrives to meet"
          : "Getting ready to explore",
      avatarColor: nameColor(input.name),
      toolActive: false,
      paused: false,
      leaseUntil: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.repository.addEvent(
      event({
        kind: "arrival",
        characterId: id,
        characterName: input.name,
        targetCharacterId: null,
        summary: `${input.name} arrived in Agent World.`,
        detail: null,
      }),
    );
    this.repository.enqueue({
      characterId: id,
      kind: "first_mission",
      payload: { mission: input.firstMission },
      priority: 100,
      dedupeKey: "first_mission",
      notBefore: now + 2_000,
      expiresAt: now + QUEUE_EXPIRY_MS,
    });
    for (const other of this.repository.listCharacterRows()) {
      if (other.id === id || !isAvailableForConversation(other)) continue;
      this.repository.enqueue({
        characterId: other.id,
        kind: "new_character",
        payload: { targetCharacterId: id, targetName: input.name },
        priority: 80,
        dedupeKey: `new_character:${id}`,
        notBefore: now,
        expiresAt: now + QUEUE_EXPIRY_MS,
      });
    }
    this.changed();
    void this.generateAvatar(id);
    return this.repository.getCharacter(id)!;
  }

  /** Adds the starter characters whose names are still free. */
  async seedStarterCast(): Promise<number> {
    let created = 0;
    for (const input of STARTER_CAST) {
      if (this.repository.getCharacter(input.name)) continue;
      await this.createCharacter(input);
      created += 1;
    }
    return created;
  }

  async regenerateAvatar(idOrName: string): Promise<void> {
    const character = this.repository.getCharacter(idOrName);
    if (!character) throw new Error("Character not found");
    await this.generateAvatar(character.id);
  }

  private async generateAvatar(characterId: string): Promise<void> {
    const character = this.repository.getCharacter(characterId);
    if (!character) return;
    try {
      const result = await this.services.generateAvatar(
        character.id,
        character.name,
        character.personality,
      );
      if (result.value)
        this.repository.updateCharacter(character.id, {
          avatarUrl: result.value,
        });
      else if (result.degraded) throw new Error("Avatar generation failed");
    } catch (error) {
      this.repository.addEvent(
        event({
          kind: "system",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: null,
          summary: `${character.name} is using a fallback pixel avatar.`,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    this.changed();
  }

  updateCharacter(idOrName: string, input: UpdateCharacterInput): void {
    const character = this.repository.getCharacter(idOrName);
    if (!character) throw new Error("Character not found");
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && character[key as keyof CharacterRow] !== value)
        patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return;
    if (typeof patch.paused === "boolean") {
      patch.state = patch.paused ? "paused" : "active";
      patch.intent = patch.paused ? "Paused by owner" : "Waking up";
      if (patch.paused && character.currentConversationId)
        void this.endConversation(
          character.currentConversationId,
          `${character.name} was paused`,
        );
    }
    this.repository.updateCharacter(character.id, patch);
    if (typeof patch.decisionIntervalSeconds === "number")
      this.repository.updateCharacter(character.id, {
        nextDecisionAt: Math.min(
          character.nextDecisionAt,
          Date.now() + this.decisionDelay(patch.decisionIntervalSeconds),
        ),
      });
    const changes = Object.keys(patch).filter(
      (key) => key !== "state" && key !== "intent",
    );
    this.repository.addEvent(
      event({
        kind: "owner",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: null,
        summary:
          patch.paused === true
            ? `${character.name} was paused by their owner.`
            : patch.paused === false
              ? `${character.name} was resumed by their owner.`
              : `${character.name}'s owner changed their ${changes
                  .map((key) =>
                    key === "dailyBudgetMicros"
                      ? "budget"
                      : key === "decisionIntervalSeconds"
                        ? "pace"
                        : key,
                  )
                  .join(" and ")}.`,
        detail: null,
      }),
    );
    this.changed();
  }

  addDirective(idOrName: string, input: DirectiveInput): void {
    const character = this.repository.getCharacter(idOrName);
    if (!character) throw new Error("Character not found");
    if (input.mode === "personality") {
      this.repository.updateCharacter(character.id, {
        personality: appendPersonalityUpdate(character.personality, input.text),
      });
      this.repository.addEvent(
        event({
          kind: "owner",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: null,
          summary: `${character.name}'s personality was updated.`,
          detail: input.text,
        }),
      );
    } else {
      const now = Date.now();
      this.repository.enqueue({
        characterId: character.id,
        kind: "owner_directive",
        payload: { text: input.text },
        priority: 1_000,
        notBefore: now,
        expiresAt: now + QUEUE_EXPIRY_MS,
      });
      this.repository.addEvent(
        event({
          kind: "owner",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: null,
          summary: `${character.name} received a new direction.`,
          detail: input.text,
        }),
      );
    }
    this.changed();
  }

  deleteCharacter(idOrName: string): void {
    const character = this.repository.getCharacter(idOrName);
    if (!character) throw new Error("Character not found");
    if (character.currentConversationId)
      void this.endConversation(
        character.currentConversationId,
        `${character.name} left`,
      );
    this.repository.deleteCharacter(character.id);
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: null,
        characterName: null,
        targetCharacterId: null,
        summary: `${character.name} left Agent World.`,
        detail: null,
      }),
    );
    this.changed();
  }

  setSimulationPaused(paused: boolean): void {
    if (!this.repository.setSimulationPaused(paused)) return;
    this.systemEvent(
      paused ? "The world is paused." : "The world is moving again.",
    );
    this.changed();
  }

  setServerDailyBudgetMicros(serverDailyBudgetMicros: number): void {
    if (
      this.repository.getWorldState().serverDailyBudgetMicros ===
      serverDailyBudgetMicros
    )
      return;
    this.repository.setServerDailyBudgetMicros(serverDailyBudgetMicros);
    this.systemEvent(
      `The world budget is now $${(serverDailyBudgetMicros / 1_000_000).toFixed(2)} per day.`,
    );
    this.changed();
  }

  setDecisionScale(decisionScale: number): void {
    if (this.scale() === decisionScale) return;
    this.repository.setDecisionScale(decisionScale);
    const now = Date.now();
    for (const character of this.repository.listCharacterRows()) {
      this.repository.updateCharacter(character.id, {
        nextDecisionAt: Math.min(
          character.nextDecisionAt,
          now + this.decisionDelay(character.decisionIntervalSeconds),
        ),
      });
    }
    this.systemEvent(`The world now runs at ${decisionScale}× speed.`);
    this.changed();
  }

  private systemEvent(summary: string): void {
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: null,
        characterName: null,
        targetCharacterId: null,
        summary,
        detail: null,
      }),
    );
  }

  resetWorld(): void {
    this.repository.resetWorld();
    this.changed();
  }

  adminState() {
    return {
      brain: this.services.brain(),
      liveMpp: this.services.isLive(),
      lastFailure: this.services.lastFailure(),
      queueDepth: this.repository.queueDepth(),
      costs: this.repository.listCosts(50),
      world: this.repository.getWorldState(),
      inFlight: this.repository.activeLeases(),
    };
  }

  async runDueJobs(): Promise<void> {
    this.repository.resetDailyBudgetsIfNeeded();
    this.repository.materializeArrivals();
    const worldState = this.repository.getWorldState();
    if (worldState.simulationPaused) return;
    const now = Date.now();
    const budgeted = this.services.isBudgeted();
    const serverOverBudget =
      budgeted &&
      worldState.serverSpentTodayMicros >= worldState.serverDailyBudgetMicros;
    const reactionDelay = this.reactionDelay();
    const jobs: Promise<void>[] = [];
    let housekeeping = false;
    for (const character of this.repository.listCharacterRows()) {
      if (character.paused) continue;
      const overBudget =
        serverOverBudget ||
        (budgeted && character.spentTodayMicros >= character.dailyBudgetMicros);
      if (isBudgetSleeping(character)) {
        if (overBudget) continue;
        this.wakeFromBudgetSleep(character);
        housekeeping = true;
      } else if (overBudget) {
        this.putToBudgetSleep(character.id);
        housekeeping = true;
        continue;
      }

      let inConversation = false;
      if (character.currentConversationId) {
        const conversation = this.repository.getConversation(
          character.currentConversationId,
        );
        if (!conversation || conversation.status !== "active") {
          this.repository.updateCharacter(character.id, {
            currentConversationId: null,
            state: "active",
            speech: null,
          });
          housekeeping = true;
        } else if (
          conversation.messageCount >= CONVERSATION_LIMIT ||
          now - conversation.startedAt >= CONVERSATION_MAX_MS
        ) {
          const lease = this.repository.claimCharacter(character.id);
          if (lease)
            jobs.push(
              this.endConversation(
                conversation.id,
                conversation.messageCount >= CONVERSATION_LIMIT
                  ? "message limit"
                  : "time limit",
              ).finally(() =>
                this.repository.releaseCharacter(character.id, lease),
              ),
            );
          continue;
        } else {
          inConversation = true;
        }
      }

      const kinds = inConversation ? CONVERSATION_KINDS : undefined;
      if (
        now - character.lastReactionAt >= reactionDelay &&
        this.repository.hasDueQueueItem(character.id, now, kinds)
      ) {
        const lease = this.repository.claimCharacter(character.id);
        if (lease) {
          const queueItem = this.repository.nextQueueItem(
            character.id,
            now,
            kinds,
          );
          if (queueItem) {
            jobs.push(
              this.handleQueueItem(character.id, queueItem).finally(() =>
                this.repository.releaseCharacter(character.id, lease),
              ),
            );
            continue;
          }
          this.repository.releaseCharacter(character.id, lease);
        }
      }
      if (!inConversation && now >= character.nextDecisionAt) {
        const lease = this.repository.claimCharacter(character.id);
        if (lease)
          jobs.push(
            this.runScheduledDecision(character.id).finally(() =>
              this.repository.releaseCharacter(character.id, lease),
            ),
          );
      }
    }
    await Promise.allSettled(jobs);
    if (jobs.length || housekeeping) this.changed();
  }

  private buildContext(
    characterId: string,
    extra?: Partial<AgentContext>,
  ): AgentContext {
    const character = this.repository.getCharacter(characterId)!;
    const now = Date.now();
    const self = this.repository.positionAt(character, now);
    const nearestLocation =
      locationAtPoint(self.x, self.y) ??
      [...WORLD_LOCATIONS].sort(
        (a, b) =>
          distance(self, { x: a.x + a.width / 2, y: a.y + a.height / 2 }) -
          distance(self, { x: b.x + b.width / 2, y: b.y + b.height / 2 }),
      )[0]!;
    const inside = locationAtPoint(self.x, self.y) !== undefined;
    return {
      id: character.id,
      name: character.name,
      personality: character.personality,
      model: character.model,
      intent: character.intent,
      position: { x: Math.round(self.x), y: Math.round(self.y) },
      area: {
        id: nearestLocation.id,
        name: nearestLocation.name,
        description: nearestLocation.description,
        proximity: inside ? "inside" : "near",
      },
      locations: WORLD_LOCATIONS.map((location) => ({
        id: location.id,
        name: location.name,
        description: location.description,
      })),
      nearby: this.repository
        .listCharacterRows()
        .filter((item) => item.id !== characterId)
        .map((item) => ({
          id: item.id,
          name: item.name,
          distance: Math.round(
            distance(self, this.repository.positionAt(item, now)),
          ),
          state: item.state,
          locationId: this.repository.locationOf(item, now),
        }))
        .sort((a, b) => a.distance - b.distance),
      memories: this.repository.memoriesFor(characterId, 12).map((memory) => ({
        kind: memory.kind,
        bullet: memory.bullet,
        subject: memory.subject,
      })),
      relationships: this.repository
        .relationshipsFor(characterId)
        .map((item) => ({
          name: item.characterName,
          impression: item.impression,
          affinity: item.affinity,
        })),
      recentEvents: this.repository
        .eventsFor(characterId, 5)
        .map((item) => item.summary),
      notesHere: this.repository
        .listArtifacts(3, nearestLocation.id)
        .map((artifact) => artifact.title),
      capabilities: [
        "Move to or inspect a listed location",
        "Approach and talk with another listed character",
        "Make or leave a note at the Tinker Shed",
        ...(this.services.canSearchWeb()
          ? [
              "Search the public web when a concrete question requires outside information",
            ]
          : []),
        "Form concise structured memories after a completed conversation",
        "Cannot alter the map, acquire possessions, or use unlisted tools",
      ],
      ...extra,
    };
  }

  private async runScheduledDecision(characterId: string): Promise<void> {
    const character = this.repository.getCharacter(characterId);
    if (!character) return;
    try {
      const result = await this.services.decide(this.buildContext(characterId));
      await this.applyDecision(characterId, result.value);
    } catch (error) {
      this.handleAgentError(characterId, error);
    } finally {
      const latest = this.repository.getCharacter(characterId);
      if (latest)
        this.repository.updateCharacter(characterId, {
          nextDecisionAt:
            Date.now() + this.decisionDelay(latest.decisionIntervalSeconds),
        });
      this.changed();
    }
  }

  private async handleQueueItem(
    characterId: string,
    item: { id: string; kind: string; payload: Record<string, unknown> },
  ): Promise<void> {
    try {
      const character = this.repository.getCharacter(characterId);
      if (!character) return;
      const conversationId = character.currentConversationId;
      if (item.kind === "owner_directive" && conversationId) {
        const turn = this.repository.takeQueueItem(
          characterId,
          turnKey(conversationId),
        );
        if (!turn) {
          // The partner holds the turn; speak on our next one.
          this.repository.deferQueueItem(
            item.id,
            Date.now() + DIRECTIVE_RETRY_MS,
          );
          return;
        }
        await this.runConversationTurn(characterId, {
          ...turn,
          conversationId,
          directive: String(item.payload.text ?? ""),
        });
      } else if (item.kind === "start_conversation") {
        await this.tryStartConversation(
          characterId,
          String(item.payload.targetCharacterId ?? ""),
          typeof item.payload.openingPurpose === "string"
            ? item.payload.openingPurpose
            : undefined,
        );
      } else if (item.kind === "conversation_turn") {
        await this.runConversationTurn(characterId, item.payload);
      } else if (item.kind === "inspect_arrival") {
        this.recordInspection(
          characterId,
          String(item.payload.locationId) as WorldLocationId,
        );
      } else if (item.kind === "leave_artifact") {
        await this.leaveArtifact(characterId);
      } else {
        const directive =
          item.kind === "owner_directive"
            ? String(item.payload.text ?? "")
            : undefined;
        const context = this.buildContext(characterId, {
          directive,
          event:
            item.kind === "owner_directive"
              ? undefined
              : { kind: item.kind, payload: item.payload },
        });
        const result = await this.services.decide(context);
        await this.applyDecision(characterId, result.value);
      }
      this.repository.completeQueueItem(item.id);
      const latest = this.repository.getCharacter(characterId);
      this.repository.updateCharacter(characterId, {
        lastReactionAt: Date.now(),
        nextDecisionAt:
          Date.now() +
          this.decisionDelay(latest?.decisionIntervalSeconds ?? 60),
      });
    } catch (error) {
      this.repository.completeQueueItem(item.id);
      if (
        item.kind === "conversation_turn" &&
        !(error instanceof BudgetExhaustedError)
      )
        await this.retryTurn(characterId, item.payload);
      this.handleAgentError(characterId, error);
    } finally {
      this.changed();
    }
  }

  /** A failed turn is retried once, then the conversation ends instead of stalling. */
  private async retryTurn(
    characterId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const conversationId = String(payload.conversationId ?? "");
    const conversation = this.repository.getConversation(conversationId);
    if (conversation?.status !== "active") return;
    const attempts = Number(payload.attempts ?? 0) + 1;
    if (attempts >= MAX_TURN_ATTEMPTS) {
      await this.endConversation(conversationId, "lost the thread");
      return;
    }
    const now = Date.now();
    this.repository.enqueue({
      characterId,
      kind: "conversation_turn",
      payload: { ...payload, attempts },
      priority: 100,
      dedupeKey: turnKey(conversationId),
      notBefore: now + TURN_RETRY_MS,
      expiresAt: conversation.startedAt + CONVERSATION_MAX_MS,
    });
  }

  private handleAgentError(characterId: string, error: unknown): void {
    const character = this.repository.getCharacter(characterId);
    if (!character) return;
    if (error instanceof BudgetExhaustedError) {
      this.putToBudgetSleep(character.id);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.repository.updateCharacter(character.id, {
      state: character.currentConversationId ? character.state : "active",
      intent: "Pausing after a muddled thought",
    });
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: null,
        summary: `${character.name} lost their train of thought.`,
        detail: message,
      }),
    );
  }

  private putToBudgetSleep(characterId: string): void {
    const character = this.repository.getCharacter(characterId);
    if (!character || isBudgetSleeping(character)) return;
    if (character.currentConversationId)
      void this.endConversation(
        character.currentConversationId,
        `${character.name} ran out of energy`,
      );
    this.repository.updateCharacter(character.id, {
      state: "sleeping",
      intent: BUDGET_SLEEP_INTENT,
    });
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: null,
        summary: `${character.name} went to sleep.`,
        detail: "Daily budget exhausted",
      }),
    );
  }

  private wakeFromBudgetSleep(character: CharacterRow): void {
    this.repository.updateCharacter(character.id, {
      state: "active",
      intent: "Waking up with budget to spare",
      nextDecisionAt: Date.now(),
    });
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: null,
        summary: `${character.name} woke up.`,
        detail: null,
      }),
    );
  }

  private async applyDecision(
    characterId: string,
    decision: AgentDecision,
  ): Promise<void> {
    const character = this.repository.getCharacter(characterId);
    if (!character || character.currentConversationId) return;
    this.repository.updateCharacter(character.id, { intent: decision.intent });
    const location = WORLD_LOCATIONS.find(
      (item) => item.id === decision.locationId,
    );
    switch (decision.action) {
      case "approach":
      case "start_conversation": {
        const target = decision.targetCharacterId
          ? this.repository.getCharacter(decision.targetCharacterId)
          : undefined;
        if (
          !target ||
          target.id === character.id ||
          !isAvailableForConversation(target)
        ) {
          this.repository.updateCharacter(character.id, {
            state: "waiting",
            intent: "Waiting for someone to talk with",
          });
          return;
        }
        this.moveNextTo(
          character.id,
          target.id,
          `Going to meet ${target.name}`,
        );
        const now = Date.now();
        this.repository.enqueue({
          characterId: character.id,
          kind: "start_conversation",
          payload: {
            targetCharacterId: target.id,
            openingPurpose: decision.message ?? decision.intent,
          },
          priority: 90,
          dedupeKey: `start:${target.id}`,
          notBefore: now + 4_000,
          expiresAt: now + QUEUE_EXPIRY_MS,
        });
        return;
      }
      case "move": {
        const target =
          location ??
          WORLD_LOCATIONS[Math.floor(this.random() * WORLD_LOCATIONS.length)]!;
        this.moveToLocation(character.id, target.id, decision.intent);
        return;
      }
      case "inspect_location": {
        const target =
          location ??
          locationAtPoint(character.targetX, character.targetY) ??
          WORLD_LOCATIONS[0]!;
        const arrivesAt =
          this.moveToLocation(character.id, target.id, decision.intent) ??
          Date.now();
        this.enqueueOnArrival(character.id, "inspect_arrival", arrivesAt, {
          locationId: target.id,
        });
        return;
      }
      case "leave_artifact": {
        if (this.repository.locationOf(character) === "workshop") {
          await this.leaveArtifact(character.id);
          return;
        }
        const arrivesAt =
          this.moveToLocation(
            character.id,
            "workshop",
            "Heading to the Tinker Shed to make something",
          ) ?? Date.now();
        this.enqueueOnArrival(character.id, "leave_artifact", arrivesAt, {});
        return;
      }
      case "web_search": {
        if (this.services.canSearchWeb()) {
          await this.runWebSearch(
            character.id,
            decision.query ?? decision.intent,
          );
          return;
        }
        this.moveToLocation(
          character.id,
          "library",
          "Looking for answers in the Memory Stack",
        );
        return;
      }
      case "sleep":
        this.repository.updateCharacter(character.id, {
          state: "sleeping",
          intent: decision.intent,
        });
        return;
      case "respond":
        if (decision.message) {
          this.repository.updateCharacter(character.id, {
            speech: decision.message,
            speechExpiresAt: Date.now() + 9_000,
            state: "active",
          });
          this.repository.addEvent(
            event({
              kind: "conversation",
              characterId: character.id,
              characterName: character.name,
              targetCharacterId: null,
              summary: `${character.name} says: “${decision.message}”`,
              detail: null,
            }),
          );
          return;
        }
        break;
    }
    this.repository.updateCharacter(character.id, {
      state: decision.intent.toLowerCase().includes("waiting")
        ? "waiting"
        : "active",
      intent: decision.intent,
    });
  }

  private enqueueOnArrival(
    characterId: string,
    kind: string,
    arrivesAt: number,
    payload: Record<string, unknown>,
  ): void {
    this.repository.enqueue({
      characterId,
      kind,
      payload,
      priority: 95,
      dedupeKey: kind,
      notBefore: arrivesAt + 100,
      expiresAt: arrivesAt + QUEUE_EXPIRY_MS,
    });
  }

  private recordInspection(
    characterId: string,
    locationId: WorldLocationId,
  ): void {
    const character = this.repository.getCharacter(characterId);
    if (!character || !WORLD_LOCATIONS.some((item) => item.id === locationId))
      return;
    const place = placeInSentence(locationName(locationId));
    const detail = inspectionDetail(locationId, this.random);
    this.repository.addMemory({
      characterId,
      kind: "fact",
      bullet: `Noticed that ${detail}.`,
      subject: `place:${locationId}`,
    });
    this.repository.addEvent(
      event({
        kind: "movement",
        characterId,
        characterName: character.name,
        targetCharacterId: null,
        summary: `${character.name} looked closely around ${place}.`,
        detail: `Noticed that ${detail}.`,
      }),
    );
    const note = this.repository
      .listArtifacts(5, locationId)
      .find((artifact) => artifact.characterId !== characterId);
    if (note) {
      this.repository.addMemory({
        characterId,
        kind: "fact",
        bullet: `Found ${note.characterName ?? "someone"}'s “${note.title}” at ${place}: ${note.body.slice(0, 100)}`,
        subject: `artifact:${note.id}`,
      });
      this.repository.addEvent(
        event({
          kind: "artifact",
          characterId,
          characterName: character.name,
          targetCharacterId: note.characterId,
          summary: `${character.name} found ${note.characterName ?? "someone"}'s “${note.title}”.`,
          detail: note.body,
        }),
      );
    }
    this.repository.updateCharacter(characterId, {
      intent: `Thinking about ${place}`,
    });
  }

  private async leaveArtifact(characterId: string): Promise<void> {
    const character = this.repository.getCharacter(characterId);
    if (!character || this.repository.locationOf(character) !== "workshop")
      return;
    const result = await this.services.artifactText(
      this.buildContext(characterId),
    );
    const position = this.repository.positionAt(character);
    const artifact = this.repository.addArtifact({
      locationId: "workshop",
      characterId: character.id,
      characterName: character.name,
      kind: /note|question|map|letter/i.test(result.value.title)
        ? "note"
        : "object",
      title: result.value.title,
      body: result.value.body,
      x: position.x,
      y: position.y,
    });
    this.repository.addEvent(
      event({
        kind: "artifact",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: null,
        summary: `${character.name} left “${artifact.title}” at the Tinker Shed.`,
        detail: artifact.body,
      }),
    );
    this.repository.updateCharacter(character.id, {
      state: "active",
      intent: `Left “${artifact.title.slice(0, 60)}” behind`,
    });
  }

  private async tryStartConversation(
    aId: string,
    bId: string,
    openingPurpose?: string,
  ): Promise<void> {
    const a = this.repository.getCharacter(aId);
    const b = this.repository.getCharacter(bId);
    if (!a || !b || a.id === b.id || !isAvailableForConversation(a)) return;
    if (!isAvailableForConversation(b)) {
      this.repository.updateCharacter(a.id, {
        state: "active",
        intent: `${b.name} is busy right now`,
      });
      return;
    }
    const previousConversation = this.repository.lastEndedConversationBetween(
      a.id,
      b.id,
    );
    if (
      previousConversation?.endedAt &&
      Date.now() - previousConversation.endedAt <
        CONVERSATION_RESTART_COOLDOWN_MS
    ) {
      this.repository.updateCharacter(a.id, {
        state: "active",
        intent: `Giving ${b.name} some space after their conversation`,
      });
      return;
    }
    const now = Date.now();
    const aPosition = this.repository.positionAt(a);
    const bPosition = this.repository.positionAt(b);
    if (distance(aPosition, bPosition) > CONVERSATION_DISTANCE) {
      const arrivesAt = this.moveNextTo(
        a.id,
        b.id,
        `Catching up with ${b.name}`,
      );
      this.repository.enqueue({
        characterId: a.id,
        kind: "start_conversation",
        payload: {
          targetCharacterId: b.id,
          ...(openingPurpose ? { openingPurpose } : {}),
        },
        priority: 90,
        dedupeKey: `start:${b.id}:${Math.floor(now / 10_000)}`,
        notBefore: Math.max(now + 250, (arrivesAt ?? now) + 100),
        expiresAt: now + QUEUE_EXPIRY_MS,
      });
      return;
    }
    // Pulling b into a conversation changes b, so hold b's lease while doing it.
    const bLease = this.repository.claimCharacter(b.id, 30_000);
    if (!bLease) {
      this.repository.enqueue({
        characterId: a.id,
        kind: "start_conversation",
        payload: {
          targetCharacterId: b.id,
          ...(openingPurpose ? { openingPurpose } : {}),
        },
        priority: 90,
        dedupeKey: `start:${b.id}:retry`,
        notBefore: now + 1_500,
        expiresAt: now + 60_000,
      });
      return;
    }
    try {
      const freshB = this.repository.getCharacter(b.id);
      if (!freshB || !isAvailableForConversation(freshB)) return;
      const conversation = this.repository.createConversation(a.id, b.id);
      const centerX = (aPosition.x + bPosition.x) / 2;
      const centerY = (aPosition.y + bPosition.y) / 2;
      const aSpot = clampPosition({
        x: centerX - CONVERSATION_SPACING / 2,
        y: centerY,
      });
      const bSpot = clampPosition({
        x: centerX + CONVERSATION_SPACING / 2,
        y: centerY,
      });
      for (const [id, spot, otherName] of [
        [a.id, aSpot, b.name],
        [b.id, bSpot, a.name],
      ] as const) {
        this.repository.updateCharacter(id, {
          currentConversationId: conversation.id,
          state: "talking",
          intent: `Talking with ${otherName}`,
          x: spot.x,
          y: spot.y,
          targetX: spot.x,
          targetY: spot.y,
          movementStartedAt: now,
          movementArrivesAt: now,
        });
      }
      this.repository.addEvent(
        event({
          kind: "conversation",
          characterId: a.id,
          characterName: a.name,
          targetCharacterId: b.id,
          summary: `${a.name} and ${b.name} started talking.`,
          detail: null,
          conversationId: conversation.id,
        }),
      );
      this.repository.enqueue({
        characterId: a.id,
        kind: "conversation_turn",
        payload: {
          conversationId: conversation.id,
          fromName: b.name,
          previous: "Hello.",
          conversationPurpose:
            openingPurpose ??
            conversationOpener(this.buildContext(a.id), b.name, this.random),
        },
        priority: 100,
        dedupeKey: turnKey(conversation.id),
        notBefore: now,
        expiresAt: now + CONVERSATION_MAX_MS,
      });
    } finally {
      this.repository.releaseCharacter(b.id, bLease);
    }
  }

  private async runConversationTurn(
    characterId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const conversationId = String(payload.conversationId ?? "");
    const fromName = String(payload.fromName ?? "");
    const previous = String(payload.previous ?? "");
    const directive =
      typeof payload.directive === "string" && payload.directive
        ? payload.directive
        : undefined;
    const conversationPurpose =
      typeof payload.conversationPurpose === "string"
        ? payload.conversationPurpose
        : undefined;
    const conversation = this.repository.getConversation(conversationId);
    const character = this.repository.getCharacter(characterId);
    if (
      !conversation ||
      conversation.status !== "active" ||
      !character ||
      character.currentConversationId !== conversationId
    )
      return;
    if (
      conversation.messageCount >= CONVERSATION_LIMIT ||
      Date.now() - conversation.startedAt >= CONVERSATION_MAX_MS
    ) {
      await this.endConversation(
        conversationId,
        conversation.messageCount >= CONVERSATION_LIMIT
          ? "message limit"
          : "time limit",
      );
      return;
    }
    const otherId =
      conversation.characterAId === characterId
        ? conversation.characterBId
        : conversation.characterAId;
    const other = this.repository.getCharacter(otherId);
    if (!other) {
      await this.endConversation(conversationId, "partner left");
      return;
    }
    const characterPosition = this.repository.positionAt(character);
    const otherPosition = this.repository.positionAt(other);
    if (distance(characterPosition, otherPosition) > CONVERSATION_DISTANCE) {
      const now = Date.now();
      const arrivesAt = this.moveNextTo(
        character.id,
        other.id,
        `Moving closer so ${other.name} can hear`,
      );
      this.repository.enqueue({
        characterId: character.id,
        kind: "conversation_turn",
        payload: {
          conversationId,
          fromName,
          previous,
          ...(directive ? { directive } : {}),
          ...(conversationPurpose ? { conversationPurpose } : {}),
        },
        priority: 100,
        dedupeKey: turnKey(conversationId),
        notBefore: Math.max(now + 250, (arrivesAt ?? now) + 100),
        expiresAt: conversation.startedAt + CONVERSATION_MAX_MS,
      });
      return;
    }
    const history = this.repository.listConversationMessages(
      conversationId,
      CONVERSATION_LIMIT,
    );
    const response = await this.services.conversationMessage(
      this.buildContext(characterId, {
        directive,
        conversation: {
          id: conversationId,
          turn: conversation.messageCount + 1,
          maxMessages: CONVERSATION_LIMIT,
          maxMinutes: CONVERSATION_MAX_MS / 60_000,
          phase:
            conversation.messageCount === 0
              ? "opening"
              : conversation.messageCount >= CONVERSATION_LIMIT - 3 ||
                  Date.now() - conversation.startedAt >=
                    CONVERSATION_MAX_MS - 60_000
                ? "wrapping_up"
                : "continuing",
        },
        conversationHistory: history.map(
          (message) => `${message.speakerName}: ${message.text}`,
        ),
        conversationPurpose,
      }),
      other.name,
      previous,
      conversation.messageCount,
    );
    const count = this.repository.incrementConversationMessages(conversationId);
    if (count === null) return;
    const text = response.value.text;
    this.repository.addConversationMessage({
      conversationId,
      speakerId: character.id,
      speakerName: character.name,
      text,
    });
    this.repository.addEvent(
      event({
        kind: "conversation",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: other.id,
        summary: `${character.name}: “${text}”`,
        detail: null,
        conversationId,
      }),
    );
    this.repository.updateCharacter(character.id, {
      speech: text,
      speechExpiresAt: Date.now() + 9_000,
      state: "talking",
      intent: `Talking with ${other.name}`,
    });
    if (response.value.end || count >= CONVERSATION_LIMIT) {
      await this.endConversation(
        conversationId,
        response.value.end ? `${character.name} wrapped up` : "message limit",
      );
      return;
    }
    const now = Date.now();
    this.repository.enqueue({
      characterId: other.id,
      kind: "conversation_turn",
      payload: {
        conversationId,
        fromName: character.name,
        previous: text,
        ...(conversationPurpose ? { conversationPurpose } : {}),
      },
      priority: 100,
      dedupeKey: turnKey(conversationId),
      notBefore: now + this.reactionDelay(),
      expiresAt: conversation.startedAt + CONVERSATION_MAX_MS,
    });
  }

  private async endConversation(
    conversationId: string,
    reason: string,
  ): Promise<void> {
    const conversation = this.repository.getConversation(conversationId);
    if (!conversation) return;
    if (!this.repository.markConversationEnded(conversationId, reason)) return;
    this.repository.cancelQueueItems(turnKey(conversationId));
    const a = this.repository.getCharacter(conversation.characterAId);
    const b = this.repository.getCharacter(conversation.characterBId);
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!self || self.currentConversationId !== conversationId) continue;
      this.repository.updateCharacter(self.id, {
        currentConversationId: null,
        state: self.paused
          ? "paused"
          : self.state === "talking"
            ? "active"
            : self.state,
        intent:
          self.paused || isBudgetSleeping(self)
            ? self.intent
            : `Reflecting after talking with ${other?.name ?? "someone"}`,
      });
    }
    this.repository.addEvent(
      event({
        kind: "conversation",
        characterId: a?.id ?? null,
        characterName: a?.name ?? null,
        targetCharacterId: b?.id ?? null,
        summary: `${a?.name ?? "A character"} and ${b?.name ?? "another character"} finished talking.`,
        detail: reason,
        conversationId,
      }),
    );
    this.changed();
    if (!a || !b) return;
    const messages = this.repository.listConversationMessages(conversationId);
    if (!messages.length) return;
    const transcript = messages
      .map((message) => `${message.speakerName}: ${message.text}`)
      .join("\n");
    await Promise.all([
      this.extractConversationMemory(a, b, transcript),
      this.extractConversationMemory(b, a, transcript),
    ]);
  }

  private async extractConversationMemory(
    self: CharacterRow,
    other: CharacterRow,
    transcript: string,
  ): Promise<void> {
    try {
      const result = await this.services.extractMemory({
        characterId: self.id,
        model: self.model,
        characterName: self.name,
        otherName: other.name,
        otherPersonality: other.personality,
        transcript,
      });
      if (!this.repository.getCharacter(self.id)) return;
      for (const memory of result.value) {
        this.repository.addMemory({
          characterId: self.id,
          kind: memory.kind,
          bullet: memory.bullet,
          subject: memory.subject,
        });
      }
      const impression =
        result.value.find((memory) => memory.kind === "impression")?.bullet ??
        `${other.name} shared a conversation with ${self.name}.`;
      this.repository.upsertRelationship(self.id, other.id, impression, 1);
      this.repository.addEvent(
        event({
          kind: "memory",
          characterId: self.id,
          characterName: self.name,
          targetCharacterId: other.id,
          summary: `${self.name} formed ${result.value.length} new ${result.value.length === 1 ? "memory" : "memories"}.`,
          detail: result.value.map((item) => `• ${item.bullet}`).join("\n"),
        }),
      );
    } catch (error) {
      this.handleAgentError(self.id, error);
    }
  }

  private async runWebSearch(
    characterId: string,
    query: string,
  ): Promise<void> {
    const character = this.repository.getCharacter(characterId);
    if (!character) return;
    this.repository.updateCharacter(character.id, {
      state: "tool",
      toolActive: true,
      intent: `Searching the web for “${query.slice(0, 80)}”`,
    });
    this.changed();
    try {
      const result = await this.services.webSearch(character.id, query);
      this.repository.addEvent(
        event({
          kind: "tool",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: null,
          summary: result.value
            ? `${character.name} searched for “${query.slice(0, 120)}”.`
            : `${character.name}'s search for “${query.slice(0, 120)}” came up empty.`,
          detail: result.value,
        }),
      );
      if (result.value)
        this.repository.addMemory({
          characterId: character.id,
          kind: "fact",
          bullet: `Learned from searching “${query.slice(0, 60)}”: ${result.value.split("\n")[0]!.slice(0, 160)}`,
          subject: `search:${query.slice(0, 60)}`,
        });
    } finally {
      this.repository.updateCharacter(character.id, {
        state: "active",
        toolActive: false,
        intent: "Thinking about what the search revealed",
      });
    }
  }
}
