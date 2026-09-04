import type {
  CreateCharacterInput,
  DirectiveInput,
  UpdateCharacterInput,
  WorldEvent,
  WorldSnapshot,
} from "@agent-world/shared";
import {
  WORLD_HEIGHT,
  WORLD_LOCATIONS,
  WORLD_WIDTH,
  nameColor,
} from "@agent-world/shared";
import type { WorldStore } from "@agent-world/db";
import {
  PaidServices,
  type AgentContext,
  type AgentDecision,
} from "./services.js";

const MOVE_SPEED_PER_SECOND = 92;
const CONVERSATION_DISTANCE = 78;
const CONVERSATION_SPACING = 64;
const CONVERSATION_LIMIT = 20;
const CONVERSATION_MAX_MS = 10 * 60_000;
const CONVERSATION_RESTART_COOLDOWN_MS = 2 * 60_000;
const QUEUE_EXPIRY_MS = 30 * 60_000;
const BUDGET_SLEEP_INTENT = "Sleeping until the daily budget resets";
const CHARACTER_BOUNDS = {
  left: 45,
  right: WORLD_WIDTH - 45,
  top: 90,
  bottom: WORLD_HEIGHT - 90,
};
const LOCATION_WAYPOINTS: Record<string, Array<{ x: number; y: number }>> = {
  plaza: [
    { x: 455, y: 275 },
    { x: 690, y: 275 },
    { x: 455, y: 420 },
    { x: 690, y: 420 },
  ],
  cafe: [
    { x: 300, y: 300 },
    { x: 382, y: 245 },
    { x: 365, y: 345 },
  ],
  park: [
    { x: 790, y: 245 },
    { x: 900, y: 285 },
    { x: 960, y: 385 },
    { x: 820, y: 390 },
  ],
  library: [
    { x: 370, y: 595 },
    { x: 310, y: 605 },
    { x: 470, y: 610 },
  ],
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

export class WorldEngine {
  private readonly services: PaidServices;

  constructor(
    readonly repository: WorldStore,
    private readonly changed: () => void = () => {},
    services?: PaidServices,
  ) {
    this.services = services ?? new PaidServices(repository);
    this.recoverOffMapCharacters();
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
  ): void {
    const target = clampPosition({ x: targetX, y: targetY });
    this.repository.startMovement(
      characterId,
      target.x,
      target.y,
      MOVE_SPEED_PER_SECOND,
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
    this.startMovement(
      character.id,
      otherPosition.x + directionX * CONVERSATION_SPACING,
      otherPosition.y + directionY * CONVERSATION_SPACING,
      intent,
    );
    return (
      this.repository.getCharacter(character.id)?.movementArrivesAt ?? null
    );
  }

  snapshot(connectedViewers = 0): WorldSnapshot {
    const state = this.repository.getWorldState();
    return {
      characters: this.repository.listPublicCharacters(),
      events: this.repository.listEvents(),
      locations: WORLD_LOCATIONS,
      simulationPaused: state.simulationPaused,
      serverSpentTodayMicros: state.serverSpentTodayMicros,
      serverDailyBudgetMicros: state.serverDailyBudgetMicros,
      budgetDate: state.budgetDate,
      connectedViewers,
      generatedAt: Date.now(),
    };
  }

  async createCharacter(input: CreateCharacterInput) {
    if (this.repository.getCharacter(input.name))
      throw new Error("That name already lives in Agent World");
    const now = Date.now();
    const plazaWaypoints = LOCATION_WAYPOINTS.plaza!;
    const spawn =
      plazaWaypoints[Math.floor(Math.random() * plazaWaypoints.length)]!;
    const id = crypto.randomUUID();
    const x = spawn.x + (Math.random() - 0.5) * 24;
    const y = spawn.y + (Math.random() - 0.5) * 18;
    this.repository.createCharacter({
      id,
      name: input.name,
      personality: input.personality,
      model: input.model,
      dailyBudgetMicros: input.dailyBudgetMicros,
      spentTodayMicros: 0,
      budgetDate: this.repository.getWorldState().budgetDate,
      decisionIntervalSeconds: input.decisionIntervalSeconds,
      nextDecisionAt: now + 4_000,
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
        detail:
          input.firstMission === "meet"
            ? "First mission: meet someone"
            : "First mission: explore",
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
      if (other.id === id || other.currentConversationId || other.paused)
        continue;
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
    const patch: Record<string, unknown> = { ...input };
    if (typeof input.paused === "boolean") {
      patch.state = input.paused ? "paused" : "active";
      patch.intent = input.paused ? "Paused by owner" : "Waking up";
    }
    this.repository.updateCharacter(character.id, patch);
    this.repository.addEvent(
      event({
        kind: "owner",
        characterId: character.id,
        characterName: character.name,
        targetCharacterId: null,
        summary: `${character.name}'s owner updated their settings.`,
        detail: null,
      }),
    );
    this.changed();
  }

  addDirective(idOrName: string, input: DirectiveInput): void {
    const character = this.repository.getCharacter(idOrName);
    if (!character) throw new Error("Character not found");
    if (input.mode === "personality") {
      const personality =
        `${character.personality}\nOwner update: ${input.text}`.slice(0, 800);
      this.repository.updateCharacter(character.id, { personality });
      this.repository.addEvent(
        event({
          kind: "owner",
          characterId: character.id,
          characterName: character.name,
          targetCharacterId: null,
          summary: `${character.name}'s personality was updated.`,
          detail: null,
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
      this.endConversation(character.currentConversationId, "character left");
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
    this.repository.setSimulationPaused(paused);
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: null,
        characterName: null,
        targetCharacterId: null,
        summary: paused ? "The world is paused." : "The world is moving again.",
        detail: null,
      }),
    );
    this.changed();
  }

  setServerDailyBudgetMicros(serverDailyBudgetMicros: number): void {
    this.repository.setServerDailyBudgetMicros(serverDailyBudgetMicros);
    this.repository.addEvent(
      event({
        kind: "system",
        characterId: null,
        characterName: null,
        targetCharacterId: null,
        summary: `The world budget is now $${(serverDailyBudgetMicros / 1_000_000).toFixed(2)} per day.`,
        detail: null,
      }),
    );
    this.changed();
  }

  resetWorld(): void {
    this.repository.resetWorld();
    this.changed();
  }

  adminState() {
    return {
      liveMpp: this.services.isLive(),
      queueDepth: this.repository.queueDepth(),
      costs: this.repository.listCosts(),
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
    const reactionCooldown = Number(
      process.env.AGENT_WORLD_REACTION_COOLDOWN_MS ?? 10_000,
    );
    const jobs: Promise<void>[] = [];
    for (const character of this.repository.listCharacterRows()) {
      if (character.paused) continue;
      if (
        character.state === "sleeping" &&
        character.intent === BUDGET_SLEEP_INTENT
      )
        continue;
      if (
        character.spentTodayMicros >= character.dailyBudgetMicros ||
        worldState.serverSpentTodayMicros >= worldState.serverDailyBudgetMicros
      ) {
        this.putToBudgetSleep(character.id);
        continue;
      }
      if (character.currentConversationId) {
        const conversation = this.repository.getConversation(
          character.currentConversationId,
        );
        if (
          conversation &&
          (conversation.messageCount >= CONVERSATION_LIMIT ||
            now - conversation.startedAt >= CONVERSATION_MAX_MS)
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
        }
      }
      if (now - character.lastReactionAt >= reactionCooldown) {
        const lease = this.repository.claimCharacter(character.id);
        if (lease) {
          const queueItem = this.repository.nextQueueItem(character.id, now);
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
      if (!character.currentConversationId && now >= character.nextDecisionAt) {
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
    if (jobs.length) this.changed();
  }

  private buildContext(
    characterId: string,
    extra?: Partial<AgentContext>,
  ): AgentContext {
    const character = this.repository.getCharacter(characterId)!;
    const publicCharacters = this.repository.listPublicCharacters();
    const self = publicCharacters.find((item) => item.id === characterId)!;
    const nearestLocation = [...WORLD_LOCATIONS].sort((a, b) => {
      const aDistance = distance(self, {
        x: a.x + a.width / 2,
        y: a.y + a.height / 2,
      });
      const bDistance = distance(self, {
        x: b.x + b.width / 2,
        y: b.y + b.height / 2,
      });
      return aDistance - bDistance;
    })[0]!;
    const insideNearest =
      self.x >= nearestLocation.x &&
      self.x <= nearestLocation.x + nearestLocation.width &&
      self.y >= nearestLocation.y &&
      self.y <= nearestLocation.y + nearestLocation.height;
    const relevantEvents = this.repository
      .listEvents()
      .filter(
        (item) =>
          item.kind !== "conversation" &&
          item.kind !== "system" &&
          (item.characterId === characterId ||
            item.targetCharacterId === characterId),
      )
      .slice(0, 5)
      .map((item) => item.summary);
    return {
      id: character.id,
      name: character.name,
      personality: character.personality,
      model: character.model,
      intent: character.intent,
      position: {
        x: Math.round(self.x),
        y: Math.round(self.y),
      },
      area: {
        id: nearestLocation.id,
        name: nearestLocation.name,
        description: nearestLocation.description,
        proximity: insideNearest ? "inside" : "near",
      },
      locations: WORLD_LOCATIONS.map((location) => ({
        id: location.id,
        name: location.name,
        description: location.description,
      })),
      nearby: publicCharacters
        .filter((item) => item.id !== characterId)
        .map((item) => ({
          id: item.id,
          name: item.name,
          distance: distance(self, item),
          state: item.state,
        }))
        .sort((a, b) => a.distance - b.distance),
      memories: self.memories.slice(0, 12).map((memory) => ({
        kind: memory.kind,
        bullet: memory.bullet,
        subject: memory.subject,
      })),
      recentEvents: relevantEvents,
      capabilities: [
        "Move to or inspect a listed location",
        "Approach and talk with another listed character",
        "Search the public web when a concrete question requires outside information",
        "Form concise structured memories after a completed conversation",
        "Cannot build, alter the map, acquire possessions, or use unlisted tools yet",
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
          nextDecisionAt: Date.now() + latest.decisionIntervalSeconds * 1_000,
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
      if (item.kind === "owner_directive" && character.currentConversationId) {
        const conversation = this.repository.getConversation(
          character.currentConversationId,
        );
        if (conversation?.status === "active") {
          const otherId =
            conversation.characterAId === characterId
              ? conversation.characterBId
              : conversation.characterAId;
          const other = this.repository.getCharacter(otherId);
          if (other) {
            const previous =
              this.repository
                .listEvents()
                .find(
                  (candidate) =>
                    candidate.detail ===
                    `conversation:${character.currentConversationId}`,
                )?.summary ?? "Continue the current conversation.";
            await this.runConversationTurn(
              characterId,
              conversation.id,
              other.name,
              previous,
              String(item.payload.text ?? ""),
            );
          }
        }
      } else if (item.kind === "start_conversation") {
        await this.tryStartConversation(
          characterId,
          String(item.payload.targetCharacterId ?? ""),
          typeof item.payload.openingPurpose === "string"
            ? item.payload.openingPurpose
            : undefined,
        );
      } else if (item.kind === "conversation_turn") {
        await this.runConversationTurn(
          characterId,
          String(item.payload.conversationId ?? ""),
          String(item.payload.fromName ?? ""),
          String(item.payload.previous ?? ""),
          typeof item.payload.directive === "string"
            ? item.payload.directive
            : undefined,
          typeof item.payload.conversationPurpose === "string"
            ? item.payload.conversationPurpose
            : undefined,
        );
      } else {
        const directive =
          item.kind === "owner_directive"
            ? String(item.payload.text ?? "")
            : undefined;
        const context = this.buildContext(characterId, {
          directive,
          event: { kind: item.kind, payload: item.payload },
        });
        const result = await this.services.decide(context);
        await this.applyDecision(characterId, result.value);
      }
      this.repository.completeQueueItem(item.id);
      const latest = this.repository.getCharacter(characterId);
      this.repository.updateCharacter(characterId, {
        lastReactionAt: Date.now(),
        nextDecisionAt:
          Date.now() + (latest?.decisionIntervalSeconds ?? 60) * 1_000,
      });
    } catch (error) {
      this.repository.completeQueueItem(item.id);
      this.handleAgentError(characterId, error);
    } finally {
      this.changed();
    }
  }

  private handleAgentError(characterId: string, error: unknown): void {
    const character = this.repository.getCharacter(characterId);
    if (!character) return;
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = message === "Daily budget exhausted";
    if (exhausted) {
      this.putToBudgetSleep(character.id);
      return;
    }
    this.repository.updateCharacter(character.id, {
      state: "active",
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
    if (!character) return;
    if (
      character.state === "sleeping" &&
      character.intent === BUDGET_SLEEP_INTENT
    )
      return;
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

  private async applyDecision(
    characterId: string,
    decision: AgentDecision,
  ): Promise<void> {
    const character = this.repository.getCharacter(characterId);
    if (!character) return;
    this.repository.updateCharacter(character.id, { intent: decision.intent });
    if (
      decision.action === "approach" ||
      decision.action === "start_conversation"
    ) {
      const target = decision.targetCharacterId
        ? this.repository.getCharacter(decision.targetCharacterId)
        : undefined;
      if (!target || target.currentConversationId || target.paused) {
        this.repository.updateCharacter(character.id, {
          state: "waiting",
          intent: "Waiting for someone to talk with",
        });
        return;
      }
      this.moveNextTo(character.id, target.id, `Going to meet ${target.name}`);
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
    if (decision.action === "move" || decision.action === "inspect_location") {
      const location =
        WORLD_LOCATIONS.find((item) => item.id === decision.locationId) ??
        WORLD_LOCATIONS[Math.floor(Math.random() * WORLD_LOCATIONS.length)]!;
      const waypoints =
        LOCATION_WAYPOINTS[location.id] ?? LOCATION_WAYPOINTS.plaza!;
      const target = waypoints[Math.floor(Math.random() * waypoints.length)]!;
      const targetX = target.x + (Math.random() - 0.5) * 22;
      const targetY = target.y + (Math.random() - 0.5) * 16;
      this.startMovement(character.id, targetX, targetY, decision.intent);
      return;
    }
    if (decision.action === "web_search") {
      await this.runWebSearch(character.id, decision.query ?? decision.intent);
      return;
    }
    if (decision.action === "sleep") {
      this.repository.updateCharacter(character.id, {
        state: "sleeping",
        intent: decision.intent,
      });
      return;
    }
    this.repository.updateCharacter(character.id, {
      state: decision.intent.toLowerCase().includes("waiting")
        ? "waiting"
        : "active",
      intent: decision.intent,
    });
  }

  private async tryStartConversation(
    aId: string,
    bId: string,
    openingPurpose?: string,
  ): Promise<void> {
    const a = this.repository.getCharacter(aId);
    const b = this.repository.getCharacter(bId);
    if (
      !a ||
      !b ||
      a.currentConversationId ||
      b.currentConversationId ||
      b.paused
    )
      return;
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
    const aPosition = this.repository.positionAt(a);
    const bPosition = this.repository.positionAt(b);
    if (distance(aPosition, bPosition) > CONVERSATION_DISTANCE) {
      const arrivesAt = this.moveNextTo(
        a.id,
        b.id,
        `Catching up with ${b.name}`,
      );
      const now = Date.now();
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
    const conversation = this.repository.createConversation(a.id, b.id);
    const now = Date.now();
    const centerX = (aPosition.x + bPosition.x) / 2;
    const centerY = (aPosition.y + bPosition.y) / 2;
    const aConversationPosition = clampPosition({
      x: centerX - CONVERSATION_SPACING / 2,
      y: centerY,
    });
    const bConversationPosition = clampPosition({
      x: centerX + CONVERSATION_SPACING / 2,
      y: centerY,
    });
    this.repository.updateCharacter(a.id, {
      currentConversationId: conversation.id,
      state: "talking",
      intent: `Talking with ${b.name}`,
      x: aConversationPosition.x,
      y: aConversationPosition.y,
      targetX: aConversationPosition.x,
      targetY: aConversationPosition.y,
      movementStartedAt: now,
      movementArrivesAt: now,
    });
    this.repository.updateCharacter(b.id, {
      currentConversationId: conversation.id,
      state: "talking",
      intent: `Talking with ${a.name}`,
      x: bConversationPosition.x,
      y: bConversationPosition.y,
      targetX: bConversationPosition.x,
      targetY: bConversationPosition.y,
      movementStartedAt: now,
      movementArrivesAt: now,
    });
    this.repository.addEvent(
      event({
        kind: "conversation",
        characterId: a.id,
        characterName: a.name,
        targetCharacterId: b.id,
        summary: `${a.name} and ${b.name} started talking.`,
        detail: `conversation:${conversation.id}`,
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
          `Compare grounded observations about ${this.buildContext(a.id).area.name}`,
      },
      priority: 100,
      notBefore: now,
      expiresAt: now + CONVERSATION_MAX_MS,
    });
  }

  private async runConversationTurn(
    characterId: string,
    conversationId: string,
    fromName: string,
    previous: string,
    directive?: string,
    conversationPurpose?: string,
  ): Promise<void> {
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
    if (!other) return;
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
        dedupeKey: `rejoin:${conversationId}:${character.id}:${Math.floor(now / 1_000)}`,
        notBefore: Math.max(now + 250, (arrivesAt ?? now) + 100),
        expiresAt: conversation.startedAt + CONVERSATION_MAX_MS,
      });
      return;
    }
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
        conversationHistory: this.repository
          .listEvents()
          .filter((item) => item.detail === `conversation:${conversationId}`)
          .slice(0, 6)
          .reverse()
          .map((item) => item.summary),
        conversationPurpose,
      }),
      other.name,
      previous,
      conversation.messageCount,
    );
    const messageEvent = event({
      kind: "conversation",
      characterId: character.id,
      characterName: character.name,
      targetCharacterId: other.id,
      summary: `${character.name}: “${response.value}”`,
      detail: `conversation:${conversationId}`,
    });
    this.repository.addEvent(messageEvent);
    this.repository.updateCharacter(character.id, {
      speech: response.value,
      speechExpiresAt: Date.now() + 9_000,
      state: "talking",
      intent: `Talking with ${other.name}`,
    });
    this.repository.updateConversation(conversationId, {
      messageCount: conversation.messageCount + 1,
    });
    const now = Date.now();
    this.repository.enqueue({
      characterId: other.id,
      kind: "conversation_turn",
      payload: {
        conversationId,
        fromName: character.name,
        previous: response.value,
        ...(conversationPurpose ? { conversationPurpose } : {}),
      },
      priority: 100,
      notBefore:
        now + Number(process.env.AGENT_WORLD_REACTION_COOLDOWN_MS ?? 10_000),
      expiresAt: conversation.startedAt + CONVERSATION_MAX_MS,
    });
  }

  private async endConversation(
    conversationId: string,
    reason: string,
  ): Promise<void> {
    const conversation = this.repository.getConversation(conversationId);
    if (!conversation || conversation.status !== "active") return;
    const a = this.repository.getCharacter(conversation.characterAId);
    const b = this.repository.getCharacter(conversation.characterBId);
    this.repository.updateConversation(conversationId, {
      status: "ended",
      endedAt: Date.now(),
      terminationReason: reason,
    });
    if (a)
      this.repository.updateCharacter(a.id, {
        currentConversationId: null,
        state: "active",
        speech: null,
        intent: `Reflecting after talking with ${b?.name ?? "someone"}`,
      });
    if (b)
      this.repository.updateCharacter(b.id, {
        currentConversationId: null,
        state: "active",
        speech: null,
        intent: `Reflecting after talking with ${a?.name ?? "someone"}`,
      });
    this.repository.addEvent(
      event({
        kind: "conversation",
        characterId: a?.id ?? null,
        characterName: a?.name ?? null,
        targetCharacterId: b?.id ?? null,
        summary: `${a?.name ?? "A character"} and ${b?.name ?? "another character"} finished talking.`,
        detail: reason,
      }),
    );
    if (a && b) {
      const transcript = this.repository
        .listEvents()
        .filter((item) => item.detail === `conversation:${conversationId}`)
        .reverse()
        .map((item) => item.summary)
        .join("\n");
      await Promise.all([
        this.extractConversationMemory(
          a.id,
          a.name,
          a.model,
          b.id,
          b.name,
          transcript,
        ),
        this.extractConversationMemory(
          b.id,
          b.name,
          b.model,
          a.id,
          a.name,
          transcript,
        ),
      ]);
    }
  }

  private async extractConversationMemory(
    characterId: string,
    characterName: string,
    model: string,
    otherId: string,
    otherName: string,
    transcript: string,
  ): Promise<void> {
    try {
      const result = await this.services.extractMemory(
        characterId,
        model,
        characterName,
        otherName,
        transcript,
      );
      for (const memory of result.value) {
        this.repository.addMemory({
          characterId,
          kind: memory.kind,
          bullet: memory.bullet,
          subject: memory.subject,
        });
      }
      const impression =
        result.value.find((memory) => memory.kind === "impression")?.bullet ??
        `${otherName} shared a conversation with ${characterName}.`;
      this.repository.upsertRelationship(characterId, otherId, impression, 1);
      this.repository.addEvent(
        event({
          kind: "memory",
          characterId,
          characterName,
          targetCharacterId: otherId,
          summary: `${characterName} formed ${result.value.length} new ${result.value.length === 1 ? "memory" : "memories"}.`,
          detail: result.value.map((item) => `• ${item.bullet}`).join("\n"),
        }),
      );
    } catch (error) {
      this.handleAgentError(characterId, error);
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
          summary: `${character.name} searched for “${query.slice(0, 120)}”.`,
          detail: result.value,
        }),
      );
      this.repository.addMemory({
        characterId: character.id,
        kind: "fact",
        bullet: `Searched the web for “${query.slice(0, 100)}”.`,
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
