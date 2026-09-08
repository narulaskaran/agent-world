import { neon } from "@neondatabase/serverless";
import {
  createHandler,
  fetchSessionUserId,
  parseEnv,
  type Request,
} from "./handler.js";
import {
  DEFAULT_DAILY_LIMIT_MICROS,
  FailClosedOnrampProvider,
  GatedWalletProvider,
  PaymentService,
  ToolRegistry,
  WalletFundingService,
  WalletService,
} from "./wallet-payment.js";
import { NeonStore, type NeonSql } from "./neon-store.js";

export { createHandler, parseEnv, isAdmin, hasCronAccess } from "./handler.js";
export { MemoryStore } from "./memory-store.js";
export { NeonStore } from "./neon-store.js";
export { runAutonomy, executeJob, enqueueTick, positionAt } from "./jobs.js";
export { CLAIM_JOB_SQL } from "./store.js";
export {
  DEFAULT_DAILY_LIMIT_MICROS,
  MemoryWalletStore,
  MockWalletProvider,
  GatedWalletProvider,
  DenyPaymentSigner,
  MockPaymentSigner,
  FailClosedReceiptVerifier,
  MockReceiptVerifier,
  FailClosedOnrampProvider,
  GatedOnrampProvider,
  PaymentError,
  PaymentService,
  ToolRegistry,
  WalletFundingService,
  WalletService,
} from "./wallet-payment.js";
export type {
  Wallet,
  Payment,
  PaymentState,
  ToolManifest,
  ToolManifestInput,
  WalletPaymentStore,
  AuditEntry,
  SpendPause,
  VerifiedReceipt,
  PaymentSigner,
  ReceiptVerifier,
  OnrampProvider,
  OnrampSession,
  OnrampSessionRequest,
} from "./wallet-payment.js";

export function createProductionHandler() {
  const sql = neon(
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  ) as unknown as NeonSql;
  const store = new NeonStore(sql);
  const env = parseEnv(process.env);
  const deps = {
    store,
    env,
    sessionUserId: (request: Request) =>
      fetchSessionUserId(request, env.neonAuthBaseUrl, fetch),
    now: () => Date.now(),
    fetch,
  };
  try {
    const walletService = new WalletService(
      store,
      new GatedWalletProvider(env.walletLive === true),
      () => env.walletLive === true,
    );
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      DEFAULT_DAILY_LIMIT_MICROS,
      undefined,
      undefined,
      () => Date.now(),
      walletService,
    );
    const funding = new WalletFundingService(
      store,
      new FailClosedOnrampProvider(),
      () => Date.now(),
      env.maxFundingMicros,
    );
    return createHandler({ ...deps, payments, funding });
  } catch {
    return createHandler(deps);
  }
}
