import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { NeonStore, type NeonSql } from "./neon-store.js";

const databaseUrl =
  process.env.AGENT_WORLD_NEON_TEST_URL ?? process.env.DATABASE_URL;
// CI sets AGENT_WORLD_NEON_TEST_URL from a repo secret or a disposable neon.new
// database. Without either, this file stays skipped rather than failing check.
const describeNeon = databaseUrl ? describe : describe.skip;

const applySqlFile = async (sql: NeonSql, fileName: string) => {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
    "db/migrations",
    fileName,
  );
  const statements = readFileSync(path, "utf8")
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.query(statement);
};

describeNeon("Neon SKIP LOCKED claims", () => {
  it("lets only one concurrent worker claim a pending job", async () => {
    const sql = neon(databaseUrl!) as unknown as NeonSql;
    await applySqlFile(sql, "0001_hosted.sql");
    const store = new NeonStore(sql);
    await store.ensureSchema();
    const now = Date.now();
    const characterId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await store.insertCharacter({
      id: characterId,
      ownerId: `neon-test-${characterId}`,
      name: `Neon${characterId.slice(0, 8)}`,
      personality: "Curious about tiny gardens and quiet libraries",
      model: "z-ai/glm-5.3-flash",
      dailyBudgetMicros: 500_000,
      spentTodayMicros: 0,
      budgetDate: new Date(now).toISOString().slice(0, 10),
      decisionIntervalSeconds: 60,
      nextDecisionAt: now + 60_000,
      lastReactionAt: 0,
      state: "active",
      x: 455,
      y: 275,
      targetX: 455,
      targetY: 275,
      movementStartedAt: now,
      movementArrivesAt: now,
      intent: "Looking around",
      speech: null,
      speechExpiresAt: null,
      avatarUrl: null,
      avatarColor: "#579c87",
      toolActive: false,
      paused: false,
      muted: false,
      reputation: 0,
      locationId: "plaza",
      currentConversationId: null,
      createdAt: now,
      updatedAt: now,
    });
    await store.enqueueJob({
      id: jobId,
      characterId,
      kind: "tick",
      payload: {},
      priority: 10,
      dedupeKey: "tick",
      notBefore: 0,
      expiresAt: now + 60_000,
      createdAt: now,
    });
    const [first, second] = await Promise.all([
      store.claimNextJob(now, 120_000),
      store.claimNextJob(now, 120_000),
    ]);
    const won = [first, second].filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]?.id).toBe(jobId);
    await store.deleteCharacter(characterId);
  });
});
