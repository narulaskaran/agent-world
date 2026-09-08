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
    await expect(store.transaction(async () => 7)).rejects.toThrow(
      "durable financial transaction",
    );
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

describe("NeonStore.ensureSchema", () => {
  it("applies world schema without wallet DDL and skips repeats", async () => {
    const statements: string[] = [];
    const sql = fakeSql();
    sql.query = async (text: string) => {
      statements.push(text);
      if (
        /user_wallets|payment_attempts|payment_audit|funding_attempts|spend_pauses|tool_manifests|wallet_provisioning|user_daily_spend|payment_quotas/i.test(
          text,
        )
      )
        throw new Error("permission denied for table user_wallets");
      return [];
    };
    const store = new NeonStore(sql);
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    expect(
      statements.some((statement) => statement.includes("last_tick_at")),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.includes("viewer_presence")),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("characters_owner_idx"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) => /user_wallets/i.test(statement)),
    ).toBe(false);
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    const worldPasses = statements.filter((statement) =>
      statement.includes("viewer_presence"),
    );
    expect(worldPasses).toHaveLength(1);
  });

  it("applies wallet DDL only from ensureWalletSchema and stops after a Neon quota error", async () => {
    let queries = 0;
    const statements: string[] = [];
    const sql = fakeSql();
    sql.query = async (text: string) => {
      queries += 1;
      statements.push(text);
      if (
        /user_wallets|payment_attempts|funding_attempts|spend_pauses|wallet_provisioning|payment_audit|payment_quotas|tool_manifests|user_daily_spend/i.test(
          text,
        )
      )
        throw new Error(
          'Server error (HTTP status 402): {"message":"Your project has exceeded the data transfer quota."}',
        );
      return [];
    };
    const store = new NeonStore(sql);
    await store.ensureSchema();
    expect(
      statements.some((statement) => /user_wallets/i.test(statement)),
    ).toBe(false);
    const afterWorld = queries;
    await store.ensureWalletSchema();
    expect(queries).toBeGreaterThan(afterWorld);
    const afterWallet = queries;
    await store.ensureWalletSchema();
    expect(queries).toBe(afterWallet);
    await expect(store.ensureSchema()).rejects.toThrow(/data transfer quota/);
    expect(queries).toBe(afterWallet);
  });
});
