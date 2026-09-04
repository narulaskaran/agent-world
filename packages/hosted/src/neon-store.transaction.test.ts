import { describe, expect, it, vi } from "vitest";
import { NeonStore, type NeonSql } from "./neon-store.js";

const fakeSql = (extras: Partial<NeonSql> = {}): NeonSql => {
  const sql = (async () => []) as unknown as NeonSql;
  sql.query = async () => [];
  return Object.assign(sql, extras);
};

describe("NeonStore.transaction", () => {
  it("does not call neon HTTP transaction() with an interactive callback", async () => {
    const transaction = vi.fn(async () => {
      throw new Error(
        "transaction() expects an array of queries, or a function returning an array of queries",
      );
    });
    const store = new NeonStore(fakeSql({ transaction }));
    await expect(store.transaction(async () => 7)).resolves.toBe(7);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("runs the callback inside sql.begin when that API exists", async () => {
    const inner = fakeSql();
    let began = 0;
    const begin: NonNullable<NeonSql["begin"]> = async (fn) => {
      began += 1;
      return fn(inner);
    };
    const store = new NeonStore(fakeSql({ begin }));
    await expect(store.transaction(async () => 9)).resolves.toBe(9);
    expect(began).toBe(1);
  });
});
