import { neon } from "@neondatabase/serverless";
import { createHandler, fetchSessionUserId, parseEnv } from "./handler.js";
import { NeonStore, type NeonSql } from "./neon-store.js";

export { createHandler, parseEnv, isAdmin, hasCronAccess } from "./handler.js";
export { MemoryStore } from "./memory-store.js";
export { NeonStore } from "./neon-store.js";
export { runAutonomy, executeJob } from "./jobs.js";
export { CLAIM_JOB_SQL } from "./store.js";

export function createProductionHandler() {
  const sql = neon(
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  ) as unknown as NeonSql;
  const store = new NeonStore(sql);
  const env = parseEnv(process.env);
  return createHandler({
    store,
    env,
    sessionUserId: (request) =>
      fetchSessionUserId(request, env.neonAuthBaseUrl, fetch),
    now: () => Date.now(),
    fetch,
  });
}
