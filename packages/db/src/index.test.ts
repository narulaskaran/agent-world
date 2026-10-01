import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorldEvent } from "@agent-world/shared";
import { WorldRepository, localDate } from "./index.js";

describe("WorldRepository", () => {
  let repository: WorldRepository;

  beforeEach(() => {
    repository = new WorldRepository(":memory:");
    repository.createCharacter({
      id: "moss",
      name: "Moss",
      personality: "Curious about tiny gardens",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 500_000,
      spentTodayMicros: 0,
      budgetDate: localDate(),
      decisionIntervalSeconds: 60,
      nextDecisionAt: Date.now(),
      lastReactionAt: 0,
      state: "active",
      x: 10,
      y: 10,
      targetX: 10,
      targetY: 10,
      movementStartedAt: Date.now(),
      movementArrivesAt: Date.now(),
      intent: "Testing",
      avatarColor: "#579c87",
      toolActive: false,
      paused: false,
      leaseUntil: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterEach(() => repository.close());

  it("atomically enforces and releases character budget reservations", () => {
    const first = repository.reserveCost({
      characterId: "moss",
      category: "inference",
      provider: "test",
      maxMicros: 400_000,
      countAgainstCharacter: true,
    });
    expect(first).toBeTruthy();
    expect(
      repository.reserveCost({
        characterId: "moss",
        category: "tool",
        provider: "test",
        maxMicros: 200_000,
        countAgainstCharacter: true,
      }),
    ).toBeNull();
    repository.settleCost(first!, 100_000);
    expect(repository.getCharacter("moss")?.spentTodayMicros).toBe(100_000);
    expect(
      repository.reserveCost({
        characterId: "moss",
        category: "tool",
        provider: "test",
        maxMicros: 200_000,
        countAgainstCharacter: true,
      }),
    ).toBeTruthy();
  });

  it("does not charge avatar reservations to a character", () => {
    const id = repository.reserveCost({
      characterId: "moss",
      category: "avatar",
      provider: "test",
      maxMicros: 50_000,
      countAgainstCharacter: false,
    });
    expect(id).toBeTruthy();
    repository.settleCost(id!, 40_000);
    expect(repository.getCharacter("moss")?.spentTodayMicros).toBe(0);
    expect(repository.getWorldState().serverSpentTodayMicros).toBe(40_000);
  });

  it("persists a locally edited world budget", () => {
    repository.setServerDailyBudgetMicros(750_000);
    expect(repository.getWorldState().serverDailyBudgetMicros).toBe(750_000);
  });

  it("freezes active timers while the world is paused", () => {
    const now = Date.now();
    const conversation = repository.createConversation("moss", "juniper");
    repository.updateConversation(conversation.id, { startedAt: now - 1_000 });
    const queueId = repository.enqueue({
      characterId: "moss",
      kind: "conversation_turn",
      payload: {},
      priority: 1,
      notBefore: now + 5_000,
      expiresAt: now + 10_000,
    })!;
    repository.updateCharacter("moss", {
      nextDecisionAt: now + 3_000,
      movementStartedAt: now,
      movementArrivesAt: now + 10_000,
      state: "moving",
    });
    repository.setSimulationPaused(true);
    repository.sqlite
      .prepare("UPDATE world_state SET paused_at = ? WHERE id = 1")
      .run(now - 10_000);

    repository.setSimulationPaused(false);

    expect(
      repository.getConversation(conversation.id)?.startedAt,
    ).toBeGreaterThan(now + 8_000);
    const queue = repository.sqlite
      .prepare(
        "SELECT not_before AS notBefore, expires_at AS expiresAt FROM character_queue WHERE id = ?",
      )
      .get(queueId) as { notBefore: number; expiresAt: number };
    expect(queue.notBefore).toBeGreaterThan(now + 14_000);
    expect(queue.expiresAt).toBeGreaterThan(now + 19_000);
    const moss = repository.getCharacter("moss")!;
    expect(moss.nextDecisionAt).toBeGreaterThan(now + 12_000);
    expect(moss.movementArrivesAt).toBeGreaterThan(now + 19_000);
  });

  it("serves the latest 100 events and retains a longer history", () => {
    for (let index = 0; index < 105; index += 1) {
      const event: WorldEvent = {
        id: `event-${index}`,
        kind: "system",
        characterId: null,
        characterName: null,
        targetCharacterId: null,
        summary: `Event ${index}`,
        detail: null,
        createdAt: index,
      };
      repository.addEvent(event);
    }
    const events = repository.listEvents();
    expect(events).toHaveLength(100);
    expect(events[0]?.summary).toBe("Event 104");
    expect(events.at(-1)?.summary).toBe("Event 5");
    repository.prune();
    expect(repository.listEvents(500)).toHaveLength(105);
    expect(repository.recap(-1, 1_000).highlights).toHaveLength(0);
  });

  it("records real spend above the reservation", () => {
    const id = repository.reserveCost({
      characterId: "moss",
      category: "inference",
      provider: "test",
      maxMicros: 5_000,
      countAgainstCharacter: true,
    })!;
    repository.settleCost(id, 7_500);
    expect(repository.getCharacter("moss")?.spentTodayMicros).toBe(7_500);
    expect(repository.getWorldState().serverSpentTodayMicros).toBe(7_500);
    expect(repository.listCosts()[0]?.amountMicros).toBe(7_500);
  });

  it("counts conversation messages atomically and ends a conversation once", () => {
    const conversation = repository.createConversation("moss", "juniper");
    expect(repository.incrementConversationMessages(conversation.id)).toBe(1);
    expect(repository.incrementConversationMessages(conversation.id)).toBe(2);
    expect(repository.markConversationEnded(conversation.id, "done")).toBe(
      true,
    );
    expect(repository.markConversationEnded(conversation.id, "again")).toBe(
      false,
    );
    expect(
      repository.incrementConversationMessages(conversation.id),
    ).toBeNull();
  });

  it("stores transcripts outside the event feed", () => {
    const conversation = repository.createConversation("moss", "juniper");
    for (let index = 0; index < 30; index += 1)
      repository.addConversationMessage({
        conversationId: conversation.id,
        speakerId: "moss",
        speakerName: "Moss",
        text: `line ${index}`,
      });
    expect(repository.listConversationMessages(conversation.id)).toHaveLength(
      30,
    );
    expect(
      repository
        .listConversationMessages(conversation.id, 2)
        .map((message) => message.text),
    ).toEqual(["line 28", "line 29"]);
  });

  it("recovers leases, claimed work and open reservations after a restart", () => {
    repository.claimCharacter("moss", 60_000);
    const itemId = repository.enqueue({
      characterId: "moss",
      kind: "reaction",
      payload: {},
      priority: 1,
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
    })!;
    expect(repository.nextQueueItem("moss", Date.now())?.id).toBe(itemId);
    repository.reserveCost({
      characterId: "moss",
      category: "inference",
      provider: "test",
      maxMicros: 5_000,
      countAgainstCharacter: true,
    });

    repository.recoverAfterRestart();

    expect(repository.activeLeases()).toEqual([]);
    expect(repository.nextQueueItem("moss", Date.now())?.id).toBe(itemId);
    expect(repository.getCharacter("moss")?.spentTodayMicros).toBe(0);
    expect(repository.getWorldState().serverSpentTodayMicros).toBe(0);
  });

  it("only wakes budget sleepers at the daily reset", () => {
    repository.updateCharacter("moss", {
      state: "sleeping",
      intent: "Sleeping until the daily budget resets",
      spentTodayMicros: 500_000,
    });
    repository.sqlite
      .prepare("UPDATE world_state SET budget_date = '2000-01-01'")
      .run();
    repository.resetDailyBudgetsIfNeeded();
    expect(repository.getCharacter("moss")).toMatchObject({
      state: "active",
      spentTodayMicros: 0,
    });

    repository.updateCharacter("moss", {
      state: "talking",
      intent: "Chatting",
    });
    repository.sqlite
      .prepare("UPDATE world_state SET budget_date = '2000-01-01'")
      .run();
    repository.resetDailyBudgetsIfNeeded();
    expect(repository.getCharacter("moss")?.state).toBe("talking");
  });

  it("prunes finished queue rows and old cost entries", () => {
    const old = Date.now() - 10 * 24 * 60 * 60_000;
    const itemId = repository.enqueue({
      characterId: "moss",
      kind: "reaction",
      payload: {},
      priority: 1,
      notBefore: 0,
      expiresAt: Date.now() + 1_000,
    })!;
    repository.completeQueueItem(itemId);
    repository.sqlite
      .prepare("UPDATE character_queue SET created_at = ?")
      .run(old);
    const costId = repository.reserveCost({
      category: "inference",
      provider: "test",
      maxMicros: 10,
      countAgainstCharacter: false,
    })!;
    repository.settleCost(costId, 5);
    repository.sqlite
      .prepare("UPDATE cost_entries SET created_at = ?")
      .run(old);

    repository.prune();

    expect(
      repository.sqlite
        .prepare("SELECT count(*) AS count FROM character_queue")
        .get(),
    ).toEqual({ count: 0 });
    expect(repository.listCosts()).toHaveLength(0);
  });

  it("applies a configured world budget to an existing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-world-"));
    const databasePath = join(directory, "world.db");
    try {
      new WorldRepository(databasePath).close();
      const reopened = new WorldRepository(databasePath, {
        serverDailyBudgetMicros: 900_000,
      });
      expect(reopened.getWorldState().serverDailyBudgetMicros).toBe(900_000);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives a character's location from its position", () => {
    repository.updateCharacter("moss", {
      targetX: 455,
      targetY: 275,
      movementArrivesAt: 0,
      movementStartedAt: 0,
    });
    expect(repository.listPublicCharacters()[0]?.locationId).toBe("plaza");
    expect(repository.inspect("moss")?.locationId).toBe("plaza");
  });

  it("serves data-URL avatars by reference in public characters", () => {
    repository.updateCharacter("moss", {
      avatarUrl: `data:image/png;base64,${"A".repeat(10_000)}`,
    });
    const avatarUrl = repository.listPublicCharacters()[0]?.avatarUrl;
    expect(avatarUrl).toMatch(/^\/api\/characters\/moss\/avatar\?v=\d+$/);
  });

  it("supersedes active facts with the same subject", () => {
    repository.addMemory({
      characterId: "moss",
      kind: "fact",
      bullet: "Juniper likes tea.",
      subject: "Juniper",
    });
    repository.addMemory({
      characterId: "moss",
      kind: "fact",
      bullet: "Juniper prefers coffee.",
      subject: "Juniper",
    });
    expect(
      repository.memoriesFor("moss").map((memory) => memory.bullet),
    ).toEqual(["Juniper prefers coffee."]);
  });

  it("deduplicates pending targeted events", () => {
    const item = {
      characterId: "moss",
      kind: "arrival",
      payload: {},
      priority: 1,
      dedupeKey: "arrival:juniper",
      notBefore: 0,
      expiresAt: Date.now() + 1_000,
    };
    expect(repository.enqueue(item)).toBeTruthy();
    expect(repository.enqueue(item)).toBeNull();
    expect(repository.queueDepth("moss")).toBe(1);
  });

  it("recovers expired character and queue leases without letting stale workers release a new lease", () => {
    // Keep the held lease well above 1ms so a slow CI tick cannot expire it
    // before the "still claimed" assertion.
    const firstLease = repository.claimCharacter("moss", 60_000);
    expect(firstLease).toBeTruthy();
    expect(repository.claimCharacter("moss")).toBeNull();
    repository.sqlite
      .prepare("UPDATE characters SET lease_until = 0 WHERE id = ?")
      .run("moss");
    const secondLease = repository.claimCharacter("moss");
    expect(secondLease).toBeTruthy();
    repository.releaseCharacter("moss", firstLease!);
    expect(repository.activeLeases()).toEqual(["moss"]);

    const itemId = repository.enqueue({
      characterId: "moss",
      kind: "reaction",
      payload: {},
      priority: 1,
      notBefore: 0,
      expiresAt: Date.now() + 10_000,
    });
    expect(repository.nextQueueItem("moss", Date.now())?.id).toBe(itemId);
    expect(repository.nextQueueItem("moss", Date.now())).toBeUndefined();
    repository.sqlite
      .prepare("UPDATE character_queue SET not_before = 0 WHERE id = ?")
      .run(itemId);
    expect(repository.nextQueueItem("moss", Date.now())?.id).toBe(itemId);
  });

  it("restores persisted characters and queued work after reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-world-"));
    const databasePath = join(directory, "world.db");
    let diskRepository: WorldRepository | undefined;
    try {
      diskRepository = new WorldRepository(databasePath);
      diskRepository.createCharacter({
        ...repository.getCharacter("moss")!,
        id: "fern",
        name: "Fern",
      });
      diskRepository.enqueue({
        characterId: "fern",
        kind: "owner_directive",
        payload: { text: "Visit the park" },
        priority: 100,
        notBefore: 0,
        expiresAt: Date.now() + 10_000,
      });
      diskRepository.close();
      diskRepository = undefined;
      diskRepository = new WorldRepository(databasePath);
      expect(diskRepository.getCharacter("Fern")?.personality).toBe(
        "Curious about tiny gardens",
      );
      expect(diskRepository.queueDepth("fern")).toBe(1);
    } finally {
      diskRepository?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
