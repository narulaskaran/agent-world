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

  it("keeps only the latest 100 public events", () => {
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
      repository
        .listPublicCharacters()[0]
        ?.memories.map((memory) => memory.bullet),
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
    const firstLease = repository.claimCharacter("moss", 1);
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
