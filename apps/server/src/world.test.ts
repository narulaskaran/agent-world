import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorldRepository } from "@agent-world/db";
import { WorldEngine } from "./world.js";

describe("WorldEngine serverless jobs", () => {
  let repository: WorldRepository;
  let engine: WorldEngine;

  beforeEach(() => {
    process.env.AGENT_WORLD_LIVE_MPP = "false";
    process.env.AGENT_WORLD_REACTION_COOLDOWN_MS = "0";
    repository = new WorldRepository(":memory:");
    engine = new WorldEngine(repository);
  });

  afterEach(() => repository.close());

  it("advances durable first missions into persisted movement and follow-up work", async () => {
    await engine.createCharacter({
      name: "Moss",
      personality: "Curious about tiny gardens and gentle conversations.",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 500_000,
      decisionIntervalSeconds: 60,
      firstMission: "meet",
    });
    await engine.createCharacter({
      name: "Juniper",
      personality:
        "Playful, observant, and always looking for unusual stories.",
      model: "deepseek/deepseek-v4-flash",
      dailyBudgetMicros: 500_000,
      decisionIntervalSeconds: 60,
      firstMission: "explore",
    });

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
    await engine.createCharacter({
      name: "Moss",
      personality: "Curious about tiny gardens and gentle conversations.",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 500_000,
      decisionIntervalSeconds: 60,
      firstMission: "explore",
    });
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
    await engine.createCharacter({
      name: "Moss",
      personality: "Curious about tiny gardens and gentle conversations.",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 500_000,
      decisionIntervalSeconds: 60,
      firstMission: "explore",
    });
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

  it("sleeps a character whose daily budget is exhausted", async () => {
    await engine.createCharacter({
      name: "Moss",
      personality: "Curious about tiny gardens and gentle conversations.",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 50_000,
      decisionIntervalSeconds: 60,
      firstMission: "explore",
    });
    repository.updateCharacter(repository.getCharacter("Moss")!.id, {
      spentTodayMicros: 50_000,
    });

    await engine.runDueJobs();
    await engine.runDueJobs();

    expect(repository.getCharacter("Moss")?.state).toBe("sleeping");
    expect(repository.getCharacter("Moss")?.intent).toBe(
      "Sleeping until the daily budget resets",
    );
    expect(
      repository
        .listEvents()
        .filter((item) => item.summary === "Moss went to sleep."),
    ).toHaveLength(1);
  });

  it("does not retry queued work or repeat sleep events when the world cannot afford a request", async () => {
    await engine.createCharacter({
      name: "Moss",
      personality: "Curious about tiny gardens and gentle conversations.",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 50_000,
      decisionIntervalSeconds: 60,
      firstMission: "explore",
    });
    const moss = repository.getCharacter("Moss")!;
    repository.sqlite
      .prepare(
        "UPDATE world_state SET server_daily_budget_micros = 1000, server_spent_today_micros = 900",
      )
      .run();
    repository.sqlite
      .prepare("UPDATE character_queue SET not_before = 0")
      .run();
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
    expect(
      repository
        .listEvents()
        .filter((item) => item.summary === "Moss went to sleep."),
    ).toHaveLength(1);
  });

  it("applies an owner directive as the next turn of an active conversation", async () => {
    for (const name of ["Moss", "Juniper"]) {
      await engine.createCharacter({
        name,
        personality: `${name} is curious and grounded in the world.`,
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: "explore",
      });
    }
    const moss = repository.getCharacter("Moss")!;
    const juniper = repository.getCharacter("Juniper")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    const conversation = repository.createConversation(moss.id, juniper.id);
    const now = Date.now();
    repository.updateCharacter(moss.id, {
      currentConversationId: conversation.id,
      nextDecisionAt: Date.now() + 60_000,
      x: 500,
      y: 350,
      targetX: 500,
      targetY: 350,
      movementStartedAt: now,
      movementArrivesAt: now,
    });
    repository.updateCharacter(juniper.id, {
      currentConversationId: conversation.id,
      nextDecisionAt: Date.now() + 60_000,
      x: 564,
      y: 350,
      targetX: 564,
      targetY: 350,
      movementStartedAt: now,
      movementArrivesAt: now,
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

    expect(repository.getConversation(conversation.id)?.messageCount).toBe(1);
    expect(repository.queueDepth(juniper.id)).toBe(0);
    expect(repository.queueDepth(moss.id)).toBe(1);
    expect(
      repository
        .listEvents()
        .some(
          (item) =>
            item.kind === "conversation" &&
            item.characterId === juniper.id &&
            item.detail === `conversation:${conversation.id}`,
        ),
    ).toBe(true);
  });

  it("keeps conversation partners within hearing distance", async () => {
    for (const name of ["Moss", "Juniper"]) {
      await engine.createCharacter({
        name,
        personality: `${name} is curious and grounded in the world.`,
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: "explore",
      });
    }
    const moss = repository.getCharacter("Moss")!;
    const juniper = repository.getCharacter("Juniper")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    const now = Date.now();
    repository.updateCharacter(moss.id, {
      x: 500,
      y: 350,
      targetX: 500,
      targetY: 350,
      movementStartedAt: now,
      movementArrivesAt: now,
    });
    repository.updateCharacter(juniper.id, {
      x: 560,
      y: 350,
      targetX: 560,
      targetY: 350,
      movementStartedAt: now,
      movementArrivesAt: now,
    });
    repository.enqueue({
      characterId: moss.id,
      kind: "start_conversation",
      payload: {
        targetCharacterId: juniper.id,
        openingPurpose: "Compare what each noticed in Sunbeam Plaza",
      },
      priority: 100,
      notBefore: 0,
      expiresAt: now + 60_000,
    });

    await engine.runDueJobs();

    const movedMoss = repository.positionAt(repository.getCharacter(moss.id)!);
    const movedJuniper = repository.positionAt(
      repository.getCharacter(juniper.id)!,
    );
    expect(
      Math.hypot(movedMoss.x - movedJuniper.x, movedMoss.y - movedJuniper.y),
    ).toBe(64);
    expect(repository.getCharacter(moss.id)?.state).toBe("talking");
    expect(repository.getCharacter(juniper.id)?.state).toBe("talking");
    const firstTurn = repository.sqlite
      .prepare(
        "SELECT payload FROM character_queue WHERE character_id = ? AND kind = 'conversation_turn' AND status = 'pending'",
      )
      .get(moss.id) as { payload: string };
    expect(JSON.parse(firstTurn.payload)).toMatchObject({
      conversationPurpose: "Compare what each noticed in Sunbeam Plaza",
    });
  });

  it("moves back into hearing distance before speaking", async () => {
    for (const name of ["Moss", "Juniper"]) {
      await engine.createCharacter({
        name,
        personality: `${name} is curious and grounded in the world.`,
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: "explore",
      });
    }
    const moss = repository.getCharacter("Moss")!;
    const juniper = repository.getCharacter("Juniper")!;
    repository.sqlite.prepare("DELETE FROM character_queue").run();
    const conversation = repository.createConversation(moss.id, juniper.id);
    const now = Date.now();
    repository.updateCharacter(moss.id, {
      currentConversationId: conversation.id,
      x: 200,
      y: 200,
      targetX: 200,
      targetY: 200,
      movementStartedAt: now,
      movementArrivesAt: now,
    });
    repository.updateCharacter(juniper.id, {
      currentConversationId: conversation.id,
      x: 800,
      y: 500,
      targetX: 800,
      targetY: 500,
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
      notBefore: 0,
      expiresAt: now + 60_000,
    });

    await engine.runDueJobs();

    const movingMoss = repository.getCharacter(moss.id)!;
    expect(movingMoss.state).toBe("moving");
    expect(movingMoss.intent).toBe("Moving closer so Juniper can hear");
    expect(repository.getConversation(conversation.id)?.messageCount).toBe(0);
    expect(repository.queueDepth(moss.id)).toBe(1);
    expect(
      Math.hypot(
        movingMoss.targetX - repository.getCharacter(juniper.id)!.targetX,
        movingMoss.targetY - repository.getCharacter(juniper.id)!.targetY,
      ),
    ).toBeCloseTo(64, 5);
  });

  it("ends a conversation at 20 messages and extracts public memories", async () => {
    for (const [name, mission] of [
      ["Moss", "meet"],
      ["Juniper", "explore"],
    ] as const) {
      await engine.createCharacter({
        name,
        personality: `${name} is curious, thoughtful, and enjoys gentle conversations.`,
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: mission,
      });
    }
    const moss = repository.getCharacter("Moss")!;
    const juniper = repository.getCharacter("Juniper")!;
    const conversation = repository.createConversation(moss.id, juniper.id);
    repository.updateConversation(conversation.id, { messageCount: 20 });
    repository.updateCharacter(moss.id, {
      currentConversationId: conversation.id,
      state: "talking",
    });
    repository.updateCharacter(juniper.id, {
      currentConversationId: conversation.id,
      state: "talking",
    });

    await engine.runDueJobs();

    expect(repository.getConversation(conversation.id)?.status).toBe("ended");
    expect(repository.getCharacter("Moss")?.currentConversationId).toBeNull();
    expect(
      repository
        .listPublicCharacters()
        .every((character) => character.memories.length === 2),
    ).toBe(true);
  });

  it("advances ten autonomous characters without overlapping leases", async () => {
    for (let index = 0; index < 10; index += 1) {
      await engine.createCharacter({
        name: `Agent ${index}`,
        personality: `Agent ${index} is observant, warm, and eager to explore the shared world.`,
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: "explore",
      });
    }
    repository.sqlite
      .prepare("UPDATE character_queue SET not_before = 0")
      .run();

    await engine.runDueJobs();

    expect(repository.listPublicCharacters()).toHaveLength(10);
    expect(repository.activeLeases()).toEqual([]);
  });
});
