import { describe, expect, it } from "vitest";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { WorldRepository } from "./index.js";
import * as schema from "./schema.js";

const tables = (Object.values(schema) as unknown[]).filter(
  (value): value is SQLiteTable =>
    typeof value === "object" && value !== null && "getSQL" in value,
);

describe("schema parity", () => {
  it("matches the raw SQL tables column for column", () => {
    const repository = new WorldRepository(":memory:");
    try {
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const config = getTableConfig(table);
        const sqlColumns = (
          repository.sqlite
            .prepare(`PRAGMA table_info(${config.name})`)
            .all() as Array<{ name: string; notnull: number; pk: number }>
        ).map((column) => ({
          name: column.name,
          notNull: column.notnull === 1 || column.pk === 1,
        }));
        const drizzleColumns = config.columns.map((column) => ({
          name: column.name,
          notNull: column.notNull || column.primary,
        }));
        const byName = (a: { name: string }, b: { name: string }) =>
          a.name.localeCompare(b.name);
        expect(drizzleColumns.sort(byName), `${config.name} columns`).toEqual(
          sqlColumns.sort(byName),
        );
      }
    } finally {
      repository.close();
    }
  });

  it("treats character names case-insensitively", () => {
    const repository = new WorldRepository(":memory:");
    try {
      const base = {
        personality: "Curious",
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 1,
        budgetDate: "2026-01-01",
        nextDecisionAt: 0,
        x: 0,
        y: 0,
        targetX: 0,
        targetY: 0,
        avatarColor: "#000",
        createdAt: 0,
        updatedAt: 0,
      };
      repository.createCharacter({ ...base, id: "a", name: "Moss" });
      expect(() =>
        repository.createCharacter({ ...base, id: "b", name: "moss" }),
      ).toThrow(/UNIQUE/);
    } finally {
      repository.close();
    }
  });
});
