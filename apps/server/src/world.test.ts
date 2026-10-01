import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorldRepository } from "@agent-world/db";
import type { CreateCharacterInput } from "@agent-world/shared";
import { PaidServices, type JsonTransport } from "./services.js";
import {
  CONVERSATION_LIMIT,
  WorldEngine,
  appendPersonalityUpdate,
} from "./world.js";

const character = (
  name: string,
  overrides: Partial<CreateCharacterInput> = {},
): CreateCharacterInput => ({
  name,
  personality: `${name} is curious, thoughtful, and enjoys gentle conversations.`,
  model: "z-ai/glm-5.3-flash",
  dailyBudgetMicros: 500_000,
  decisionIntervalSeconds: 60,
  firstMission: "explore",
  ...overrides,
});

/** A paid-looking transport that never touches the network. */
const fakeTransport = (
  reply: () => unknown = () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({ action: "idle", intent: "Thinking" }),
        },
      },
    ],
  }),
): JsonTransport & { calls: number } => {
  const transport = {
    calls: 0,
    async requestJson<T>() {
      transport.calls += 1;
      return { body: reply() as T, metadata: {}, amountMicros: 1_000 };
    },
  };
  return transport;
};

const sleepEvents = (repository: WorldRepository, name: string) =>
  repository
    .listEvents()
    .filter((item) => item.summary === `${name} went to sleep.`);

const pendingTurns = (repository: WorldRepository, conversationId: string) =>
  (
    repository.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM character_queue WHERE dedupe_key = ? AND status IN ('pending', 'processing')",
      )
      .get(`turn:${conversationId}`) as { count: number }
  ).count;

describe("WorldEngine", () => {
  let repository: WorldRepository;
  let engine: WorldEngine;

  const placeTogether = (aId: string, bId: string) => {
    const now = Date.now();
    for (const [id, x] of [
      [aId, 500],
      [bId, 564],
    ] as const)
      repository.updateCharacter(id, {
        x,
        y: 350,
        targetX: x,
        targetY: 350,
        movementStartedAt: now,
        movementArrivesAt: now,
      });
  };

  const startConversation = async () => {
    await engine.createCharacter(character("Moss"));
    await engine.createCharacter(character("Juniper"));
    const moss = repository.getCharacter("Moss")!;
    const juniper = repository.getCharacter("Juniper")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    placeTogether(moss.id, juniper.id);
    repository.enqueue({
      characterId: moss.id,
      kind: "start_conversation",
      payload: { targetCharacterId: juniper.id },
      priority: 100,
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
    });
    await engine.runDueJobs();
    const conversationId = repository.getCharacter(
      moss.id,
    )!.currentConversationId!;
    expect(conversationId).toBeTruthy();
    return { moss, juniper, conversationId };
  };

  beforeEach(() => {
    repository = new WorldRepository(":memory:");
    engine = new WorldEngine(repository, () => {}, undefined, {
      reactionCooldownMs: 0,
    });
  });

  afterEach(() => repository.close());

  it("advances durable first missions into persisted movement and follow-up work", async () => {
    await engine.createCharacter(character("Moss", { firstMission: "meet" }));
    await engine.createCharacter(character("Juniper"));
    repository.sqlite
      .prepare("UPDATE character_queue SET not_before = 0")
      .run();
    await engine.runDueJobs();

    const moss = repository.getCharacter("Moss")!;
    expect(moss.state).toBe("moving");
    expect(moss.movementArrivesAt).toBeGreaterThan(moss.movementStartedAt);
    expect(repository.activeLeases()).toEqual([]);
    const followUp = repository.sqlite
      .prepare(
        "SELECT kind, status FROM character_queue WHERE character_id = ? AND kind = 'start_conversation'",
      )
      .get(moss.id) as { kind: string; status: string } | undefined;
    expect(followUp).toEqual({ kind: "start_conversation", status: "pending" });
  });

  it("derives movement position from a persisted segment", async () => {
    await engine.createCharacter(character("Moss"));
    const original = repository.getCharacter("Moss")!;
    repository.startMovement(
      original.id,
      original.x + 100,
      original.y,
      100,
      "Crossing the plaza",
    );
    const moving = repository.getCharacter("Moss")!;
    const halfway = repository.positionAt(
      moving,
      moving.movementStartedAt +
        (moving.movementArrivesAt - moving.movementStartedAt) / 2,
    );
    expect(halfway.x).toBeCloseTo(original.x + 50, 0);
    expect(repository.getCharacter("Moss")?.x).toBeCloseTo(original.x, 4);
  });

  it("recovers persisted characters and targets that are outside the map", async () => {
    await engine.createCharacter(character("Moss"));
    const moss = repository.getCharacter("Moss")!;
    const future = Date.now() + 60_000;
    repository.updateCharacter(moss.id, {
      x: 1_400,
      y: -200,
      targetX: 1_500,
      targetY: 900,
      movementStartedAt: future,
      movementArrivesAt: future + 60_000,
      state: "moving",
    });

    engine = new WorldEngine(repository);

    const recovered = repository.getCharacter("Moss")!;
    expect(recovered.x).toBe(1_075);
    expect(recovered.y).toBe(90);
    expect(recovered.targetX).toBe(1_075);
    expect(recovered.targetY).toBe(610);
    expect(recovered.state).toBe("active");
  });

  describe("budgets", () => {
    it("never records spend or sleeps characters when running keyless", async () => {
      await engine.createCharacter(character("Moss", { dailyBudgetMicros: 0 }));
      await engine.createCharacter(character("Juniper"));
      repository.setServerDailyBudgetMicros(0);
      for (let round = 0; round < 10; round += 1) {
        repository.sqlite.exec(
          "UPDATE character_queue SET not_before = 0; UPDATE characters SET next_decision_at = 0",
        );
        await engine.runDueJobs();
      }
      expect(repository.listCosts()).toEqual([]);
      expect(repository.getWorldState().serverSpentTodayMicros).toBe(0);
      expect(repository.getCharacter("Moss")?.spentTodayMicros).toBe(0);
      expect(repository.getCharacter("Moss")?.state).not.toBe("sleeping");
      expect(engine.snapshot().brain.budgeted).toBe(false);
    });

    it("sleeps a character whose daily budget is exhausted, once", async () => {
      engine = new WorldEngine(
        repository,
        () => {},
        new PaidServices(repository, { llmTransport: fakeTransport() }),
        { reactionCooldownMs: 0 },
      );
      await engine.createCharacter(
        character("Moss", { dailyBudgetMicros: 50_000 }),
      );
      repository.updateCharacter(repository.getCharacter("Moss")!.id, {
        spentTodayMicros: 50_000,
      });

      await engine.runDueJobs();
      await engine.runDueJobs();

      expect(repository.getCharacter("Moss")?.state).toBe("sleeping");
      expect(repository.getCharacter("Moss")?.intent).toBe(
        "Sleeping until the daily budget resets",
      );
      expect(sleepEvents(repository, "Moss")).toHaveLength(1);
    });

    it("wakes a budget sleeper as soon as its budget is raised", async () => {
      engine = new WorldEngine(
        repository,
        () => {},
        new PaidServices(repository, { llmTransport: fakeTransport() }),
        { reactionCooldownMs: 0 },
      );
      await engine.createCharacter(
        character("Moss", { dailyBudgetMicros: 50_000 }),
      );
      const moss = repository.getCharacter("Moss")!;
      repository.updateCharacter(moss.id, { spentTodayMicros: 50_000 });
      await engine.runDueJobs();
      expect(repository.getCharacter(moss.id)?.state).toBe("sleeping");

      engine.updateCharacter("Moss", { dailyBudgetMicros: 100_000 });
      await engine.runDueJobs();

      expect(repository.getCharacter(moss.id)?.state).not.toBe("sleeping");
      expect(
        repository
          .listEvents()
          .some((item) => item.summary === "Moss woke up."),
      ).toBe(true);
    });

    it("keeps queued work and does not repeat sleep events when the world cannot afford a request", async () => {
      engine = new WorldEngine(
        repository,
        () => {},
        new PaidServices(repository, { llmTransport: fakeTransport() }),
        { reactionCooldownMs: 0 },
      );
      await engine.createCharacter(
        character("Moss", { dailyBudgetMicros: 50_000 }),
      );
      const moss = repository.getCharacter("Moss")!;
      repository.sqlite
        .prepare(
          "UPDATE world_state SET server_daily_budget_micros = 1000, server_spent_today_micros = 1000",
        )
        .run();
      repository.sqlite.prepare("DELETE FROM character_queue").run();
      repository.enqueue({
        characterId: moss.id,
        kind: "owner_directive",
        payload: { text: "Explore the park" },
        priority: 50,
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
      });

      await engine.runDueJobs();
      await engine.runDueJobs();

      expect(repository.getCharacter(moss.id)?.state).toBe("sleeping");
      expect(repository.queueDepth(moss.id)).toBe(1);
      expect(sleepEvents(repository, "Moss")).toHaveLength(1);
    });

    it("falls back to the keyless brain when the provider is down", async () => {
      const failing: JsonTransport = {
        async requestJson() {
          throw new Error("OpenRouter is unavailable");
        },
      };
      const services = new PaidServices(repository, {
        llmTransport: failing,
      });
      engine = new WorldEngine(repository, () => {}, services, {
        reactionCooldownMs: 0,
      });
      await engine.createCharacter(character("Moss"));
      const moss = repository.getCharacter("Moss")!;
      repository.sqlite.prepare("DELETE FROM character_queue").run();
      repository.updateCharacter(moss.id, { nextDecisionAt: 0 });

      await engine.runDueJobs();

      const after = repository.getCharacter(moss.id)!;
      expect(after.state).not.toBe("sleeping");
      expect(after.intent).not.toBe("Getting ready to explore");
      expect(
        repository
          .listEvents()
          .some((item) => item.summary === "Moss lost their train of thought."),
      ).toBe(false);
      expect(repository.getWorldState().serverSpentTodayMicros).toBe(0);
      expect(services.lastFailure()?.message).toBe("OpenRouter is unavailable");
    });
  });

  describe("conversations", () => {
    it("applies an owner directive on the character's own next turn", async () => {
      const { moss, juniper, conversationId } = await startConversation();
      repository.cancelQueueItems(`turn:${conversationId}`);
      repository.enqueue({
        characterId: juniper.id,
        kind: "conversation_turn",
        payload: { conversationId, fromName: moss.name, previous: "Hello." },
        priority: 100,
        dedupeKey: `turn:${conversationId}`,
        notBefore: Date.now() + 60_000,
        expiresAt: Date.now() + 60_000,
      });
      repository.enqueue({
        characterId: juniper.id,
        kind: "owner_directive",
        payload: { text: "Ask Moss what you should do next" },
        priority: 1_000,
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
      });

      await engine.runDueJobs();

      expect(repository.getConversation(conversationId)?.messageCount).toBe(1);
      expect(repository.queueDepth(juniper.id)).toBe(0);
      expect(repository.queueDepth(moss.id)).toBe(1);
      expect(pendingTurns(repository, conversationId)).toBe(1);
      expect(
        repository
          .listEvents()
          .some(
            (item) =>
              item.kind === "conversation" &&
              item.characterId === juniper.id &&
              item.conversationId === conversationId,
          ),
      ).toBe(true);
    });

    it("defers a directive while the partner holds the turn instead of forking the chain", async () => {
      const { juniper, conversationId } = await startConversation();
      repository.enqueue({
        characterId: juniper.id,
        kind: "owner_directive",
        payload: { text: "Mention the fountain" },
        priority: 1_000,
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
      });
      const before = repository.getConversation(conversationId)!.messageCount;

      // Moss holds the turn; Juniper's directive must wait for Juniper's turn.
      repository.sqlite
        .prepare(
          "UPDATE character_queue SET not_before = ? WHERE dedupe_key = ?",
        )
        .run(Date.now() + 60_000, `turn:${conversationId}`);
      await engine.runDueJobs();

      expect(repository.getConversation(conversationId)!.messageCount).toBe(
        before,
      );
      expect(pendingTurns(repository, conversationId)).toBe(1);
      expect(repository.queueDepth(juniper.id, Date.now() + 10_000)).toBe(1);
    });

    it("runs a whole keyless conversation with one turn token and ends within the limit", async () => {
      const { moss, juniper, conversationId } = await startConversation();
      for (let round = 0; round < 3 * CONVERSATION_LIMIT; round += 1) {
        expect(pendingTurns(repository, conversationId)).toBeLessThanOrEqual(1);
        if (repository.getConversation(conversationId)?.status === "ended")
          break;
        await engine.runDueJobs();
      }
      const conversation = repository.getConversation(conversationId)!;
      expect(conversation.status).toBe("ended");
      expect(conversation.messageCount).toBeGreaterThan(1);
      expect(conversation.messageCount).toBeLessThanOrEqual(CONVERSATION_LIMIT);
      const transcript = repository.listConversationMessages(conversationId);
      expect(transcript).toHaveLength(conversation.messageCount);
      const lines = transcript.map((message) => message.text);
      expect(new Set(lines).size).toBe(lines.length);
      expect(repository.memoriesFor(moss.id).length).toBeGreaterThan(0);
      expect(repository.memoriesFor(juniper.id).length).toBeGreaterThan(0);
      expect(repository.relationshipsFor(moss.id)[0]?.affinity).toBe(1);
      expect(pendingTurns(repository, conversationId)).toBe(0);
    });

    it("ends a conversation at the message limit and extracts memories", async () => {
      await engine.createCharacter(character("Moss"));
      await engine.createCharacter(character("Juniper"));
      const moss = repository.getCharacter("Moss")!;
      const juniper = repository.getCharacter("Juniper")!;
      const conversation = repository.createConversation(moss.id, juniper.id);
      repository.updateConversation(conversation.id, {
        messageCount: CONVERSATION_LIMIT,
      });
      repository.addConversationMessage({
        conversationId: conversation.id,
        speakerId: moss.id,
        speakerName: moss.name,
        text: "The fountain sounds different today.",
      });
      repository.addConversationMessage({
        conversationId: conversation.id,
        speakerId: juniper.id,
        speakerName: juniper.name,
        text: "I noticed that too.",
      });
      for (const id of [moss.id, juniper.id])
        repository.updateCharacter(id, {
          currentConversationId: conversation.id,
          state: "talking",
        });

      await engine.runDueJobs();

      expect(repository.getConversation(conversation.id)?.status).toBe("ended");
      expect(repository.getCharacter("Moss")?.currentConversationId).toBeNull();
      expect(repository.getCharacter("Moss")?.state).toBe("active");
      expect(repository.memoriesFor(moss.id).length).toBeGreaterThan(0);
      expect(repository.memoriesFor(juniper.id).length).toBeGreaterThan(0);
    });

    it("keeps conversation partners within hearing distance", async () => {
      const { moss, juniper, conversationId } = await startConversation();
      const a = repository.positionAt(repository.getCharacter(moss.id)!);
      const b = repository.positionAt(repository.getCharacter(juniper.id)!);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBe(64);
      expect(repository.getCharacter(juniper.id)?.state).toBe("talking");
      expect(pendingTurns(repository, conversationId)).toBe(1);
    });

    it("moves back into hearing distance before speaking", async () => {
      await engine.createCharacter(character("Moss"));
      await engine.createCharacter(character("Juniper"));
      const moss = repository.getCharacter("Moss")!;
      const juniper = repository.getCharacter("Juniper")!;
      repository.sqlite.prepare("DELETE FROM character_queue").run();
      const conversation = repository.createConversation(moss.id, juniper.id);
      const now = Date.now();
      for (const [id, x, y] of [
        [moss.id, 200, 200],
        [juniper.id, 800, 500],
      ] as const)
        repository.updateCharacter(id, {
          currentConversationId: conversation.id,
          x,
          y,
          targetX: x,
          targetY: y,
          movementStartedAt: now,
          movementArrivesAt: now,
        });
      repository.enqueue({
        characterId: moss.id,
        kind: "conversation_turn",
        payload: {
          conversationId: conversation.id,
          fromName: juniper.name,
          previous: "Can you hear me?",
        },
        priority: 100,
        dedupeKey: `turn:${conversation.id}`,
        notBefore: 0,
        expiresAt: now + 60_000,
      });

      await engine.runDueJobs();

      const movingMoss = repository.getCharacter(moss.id)!;
      expect(movingMoss.state).toBe("moving");
      expect(movingMoss.intent).toBe("Moving closer so Juniper can hear");
      expect(repository.getConversation(conversation.id)?.messageCount).toBe(0);
      expect(pendingTurns(repository, conversation.id)).toBe(1);
      expect(
        Math.hypot(
          movingMoss.targetX - repository.getCharacter(juniper.id)!.targetX,
          movingMoss.targetY - repository.getCharacter(juniper.id)!.targetY,
        ),
      ).toBeCloseTo(64, 5);
    });

    it("does not pull a sleeping or busy character into a conversation", async () => {
      await engine.createCharacter(character("Moss"));
      await engine.createCharacter(character("Juniper"));
      const moss = repository.getCharacter("Moss")!;
      const juniper = repository.getCharacter("Juniper")!;
      repository.sqlite.prepare("DELETE FROM character_queue").run();
      placeTogether(moss.id, juniper.id);
      repository.updateCharacter(juniper.id, {
        state: "sleeping",
        intent: "Napping",
        nextDecisionAt: Date.now() + 60_000,
      });
      repository.enqueue({
        characterId: moss.id,
        kind: "start_conversation",
        payload: { targetCharacterId: juniper.id },
        priority: 100,
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
      });

      await engine.runDueJobs();

      expect(
        repository.getCharacter(moss.id)?.currentConversationId,
      ).toBeNull();
      expect(repository.getCharacter(juniper.id)?.state).toBe("sleeping");
    });

    it("ends the conversation when an owner pauses a participant", async () => {
      const { moss, juniper, conversationId } = await startConversation();
      engine.updateCharacter("Juniper", { paused: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(repository.getConversation(conversationId)?.status).toBe("ended");
      expect(
        repository.getCharacter(moss.id)?.currentConversationId,
      ).toBeNull();
      expect(repository.getCharacter(moss.id)?.state).toBe("active");
      expect(repository.getCharacter(juniper.id)?.state).toBe("paused");
      expect(pendingTurns(repository, conversationId)).toBe(0);
    });

    it("retries a failed turn once, then ends the conversation instead of stalling", async () => {
      const services = new PaidServices(repository);
      services.conversationMessage = async () => {
        throw new Error("boom");
      };
      engine = new WorldEngine(repository, () => {}, services, {
        reactionCooldownMs: 0,
      });
      const { conversationId } = await startConversation();
      for (let round = 0; round < 4; round += 1) {
        repository.sqlite
          .prepare("UPDATE character_queue SET not_before = 0")
          .run();
        await engine.runDueJobs();
      }
      const conversation = repository.getConversation(conversationId)!;
      expect(conversation.status).toBe("ended");
      expect(conversation.terminationReason).toBe("lost the thread");
    });
  });

  it("approaches the newcomer named in a new_character event", async () => {
    await engine.createCharacter(character("Moss"));
    await engine.createCharacter(character("Juniper"));
    await engine.createCharacter(character("Tinker"));
    const moss = repository.getCharacter("Moss")!;
    const tinker = repository.getCharacter("Tinker")!;
    repository.sqlite
      .prepare("DELETE FROM character_queue WHERE character_id != ?")
      .run(moss.id);
    repository.sqlite
      .prepare(
        "DELETE FROM character_queue WHERE character_id = ? AND kind != 'new_character'",
      )
      .run(moss.id);
    repository.sqlite
      .prepare(
        "DELETE FROM character_queue WHERE character_id = ? AND payload NOT LIKE ?",
      )
      .run(moss.id, `%${tinker.id}%`);

    await engine.runDueJobs();

    expect(repository.getCharacter(moss.id)?.intent).toContain("Tinker");
    const start = repository.sqlite
      .prepare(
        "SELECT payload FROM character_queue WHERE character_id = ? AND kind = 'start_conversation'",
      )
      .get(moss.id) as { payload: string };
    expect(JSON.parse(start.payload).targetCharacterId).toBe(tinker.id);
  });

  it("records what a character noticed when it arrives to inspect a place", async () => {
    await engine.createCharacter(character("Moss"));
    const moss = repository.getCharacter("Moss")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    engine.addDirective("Moss", {
      mode: "directive",
      text: "Go look around the park",
    });
    await engine.runDueJobs();
    const arrival = repository.sqlite
      .prepare(
        "SELECT payload FROM character_queue WHERE character_id = ? AND kind = 'inspect_arrival'",
      )
      .get(moss.id) as { payload: string } | undefined;
    expect(JSON.parse(arrival!.payload).locationId).toBe("park");

    const travelling = repository.getCharacter(moss.id)!;
    repository.updateCharacter(moss.id, {
      x: travelling.targetX,
      y: travelling.targetY,
      movementArrivesAt: Date.now() - 1,
      state: "active",
    });
    repository.sqlite
      .prepare("UPDATE character_queue SET not_before = 0")
      .run();
    await engine.runDueJobs();

    expect(
      repository
        .memoriesFor(moss.id)
        .some((memory) => memory.subject === "place:park"),
    ).toBe(true);
  });

  it("leaves an artifact at the Tinker Shed that others can find", async () => {
    await engine.createCharacter(character("Tinker"));
    await engine.createCharacter(character("Moss"));
    const tinker = repository.getCharacter("Tinker")!;
    const moss = repository.getCharacter("Moss")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    const shed = { x: 990, y: 520 };
    for (const id of [tinker.id, moss.id])
      repository.updateCharacter(id, {
        ...shed,
        targetX: shed.x,
        targetY: shed.y,
        movementStartedAt: 0,
        movementArrivesAt: 0,
      });
    expect(repository.locationOf(repository.getCharacter(tinker.id)!)).toBe(
      "workshop",
    );
    engine.addDirective("Tinker", {
      mode: "directive",
      text: "Make something for the others",
    });
    await engine.runDueJobs();

    const [artifact] = repository.listArtifacts();
    expect(artifact?.characterId).toBe(tinker.id);
    expect(artifact?.locationId).toBe("workshop");

    repository.enqueue({
      characterId: moss.id,
      kind: "inspect_arrival",
      payload: { locationId: "workshop" },
      priority: 95,
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
    });
    await engine.runDueJobs();
    expect(
      repository
        .memoriesFor(moss.id)
        .some((memory) => memory.subject === `artifact:${artifact!.id}`),
    ).toBe(true);
  });

  it("only records owner edits that change something", async () => {
    await engine.createCharacter(character("Moss"));
    const events = () =>
      repository.listEvents().filter((item) => item.kind === "owner");
    engine.updateCharacter("Moss", { dailyBudgetMicros: 500_000 });
    expect(events()).toHaveLength(0);
    engine.updateCharacter("Moss", { dailyBudgetMicros: 600_000 });
    expect(events()[0]?.summary).toBe("Moss's owner changed their budget.");
  });

  it("keeps personality updates bounded without dropping the base personality", () => {
    let personality = "Base personality that must survive.";
    for (let index = 0; index < 40; index += 1)
      personality = appendPersonalityUpdate(
        personality,
        `Update number ${index} with some extra words to fill space.`,
      );
    expect(personality.length).toBeLessThanOrEqual(800);
    expect(personality.startsWith("Base personality that must survive.")).toBe(
      true,
    );
    expect(personality).toContain("Update number 39");
  });

  it("seeds the starter cast once", async () => {
    expect(await engine.seedStarterCast()).toBe(3);
    expect(await engine.seedStarterCast()).toBe(0);
    expect(repository.listPublicCharacters()).toHaveLength(3);
  });

  it("does not emit pause events when the state does not change", () => {
    engine.setSimulationPaused(false);
    expect(repository.listEvents()).toHaveLength(0);
    engine.setSimulationPaused(true);
    engine.setSimulationPaused(true);
    expect(repository.listEvents()).toHaveLength(1);
  });

  it("advances ten autonomous characters without overlapping leases", async () => {
    for (let index = 0; index < 10; index += 1)
      await engine.createCharacter(character(`Agent ${index}`));
    repository.sqlite
      .prepare("UPDATE character_queue SET not_before = 0")
      .run();

    await engine.runDueJobs();

    expect(repository.listPublicCharacters()).toHaveLength(10);
    expect(repository.activeLeases()).toEqual([]);
  });

  it("schedules decisions from the stored world speed and applies changes at runtime", async () => {
    engine = new WorldEngine(repository, () => {}, undefined, {
      decisionScale: 30,
    });
    await engine.createCharacter(character("Moss"));
    const created = repository.getCharacter("Moss")!;
    expect(created.nextDecisionAt - created.createdAt).toBe(
      Math.round(4_000 / 30),
    );
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    repository.updateCharacter(created.id, { nextDecisionAt: 0 });
    const before = Date.now();
    await engine.runDueJobs();
    const after = repository.getCharacter("Moss")!.nextDecisionAt;
    expect(after).toBeGreaterThanOrEqual(before + 2_000);
    expect(after).toBeLessThan(before + 4_000);

    repository.updateCharacter(created.id, {
      nextDecisionAt: Date.now() + 60 * 60_000,
    });
    engine.setDecisionScale(60);
    expect(repository.getWorldState().decisionScale).toBe(60);
    expect(
      repository.getCharacter("Moss")!.nextDecisionAt - Date.now(),
    ).toBeLessThan(1_500);
  });

  it("does not start a second scheduled decision while a lease is held", async () => {
    let started = 0;
    let releaseHang!: () => void;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const services = new PaidServices(repository);
    services.decide = async () => {
      started += 1;
      await hang;
      return { value: { action: "idle", intent: "thinking" }, costMicros: 0 };
    };
    engine = new WorldEngine(repository, () => {}, services);
    await engine.createCharacter(character("Moss"));
    const moss = repository.getCharacter("Moss")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    repository.updateCharacter(moss.id, { nextDecisionAt: 0 });
    const first = engine.runDueJobs();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await engine.runDueJobs();
    expect(started).toBe(1);
    expect(repository.activeLeases()).toEqual([moss.id]);
    releaseHang();
    await first;
    expect(repository.activeLeases()).toEqual([]);
  });
});
