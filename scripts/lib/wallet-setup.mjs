import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ACCOUNT = "agent-world";

export function repoRootFrom(moduleUrl) {
  return dirname(dirname(fileURLToPath(moduleUrl)));
}

export function bundledMppxPaths(root) {
  return [
    join(root, "apps/server/node_modules/.bin/mppx"),
    join(root, "node_modules/.bin/mppx"),
  ];
}

export function resolveMppxBinary({
  binary,
  env = process.env,
  exists = existsSync,
  bundledPaths = [],
} = {}) {
  if (binary) return binary;
  if (env.MPPX_BIN?.trim()) return env.MPPX_BIN.trim();
  for (const candidate of bundledPaths) {
    if (exists(candidate)) return candidate;
  }
  return "mppx";
}

export function parseArgs(argv) {
  const result = { dryRun: false, check: false, account: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--check") result.check = true;
    else if (arg === "--account") {
      result.account = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

export function accountName(flag, env = process.env) {
  return flag?.trim() || env.MPPX_ACCOUNT?.trim() || DEFAULT_ACCOUNT;
}

export function parseYesNo(answer, defaultNo = true) {
  const text = String(answer ?? "")
    .trim()
    .toLowerCase();
  if (text === "y" || text === "yes") return true;
  if (text === "n" || text === "no") return false;
  return !defaultNo;
}

export function isKeychainUnavailable(result) {
  const blob = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.code ?? ""}`;
  return /KEYCHAIN_UNAVAILABLE/i.test(blob);
}

export function keychainGuidance(platform = process.platform) {
  const privateKeyNote =
    "MPPX_PRIVATE_KEY exists as a last-resort env override; it is not automated and not recommended.";
  if (platform === "linux") {
    return [
      "The OS keychain is unavailable (KEYCHAIN_UNAVAILABLE).",
      "On Linux, install libsecret-tools and make sure a secret service (for example gnome-keyring) is running.",
      privateKeyNote,
    ].join("\n");
  }
  return [
    "The OS keychain is unavailable (KEYCHAIN_UNAVAILABLE).",
    "macOS and Windows use the built-in credential store.",
    privateKeyNote,
  ].join("\n");
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.accounts)) return value.accounts;
    if (Array.isArray(value.data)) return value.data;
  }
  return [];
}

export function parseAccountList(stdout) {
  const parsed = JSON.parse(stdout);
  return asList(parsed)
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object")
        return item.name ?? item.account ?? item.id ?? "";
      return "";
    })
    .filter(Boolean);
}

export function parseAccountAddress(stdout) {
  const parsed = JSON.parse(stdout);
  if (typeof parsed === "string") return parsed;
  return (
    parsed.address ??
    parsed.publicAddress ??
    parsed.account?.address ??
    parsed.data?.address ??
    null
  );
}

export function upsertEnv(content, updates) {
  const lines = content.length ? content.split("\n") : [];
  const remaining = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) next.push(`${key}=${value}`);
  return next.join("\n").replace(/\n*$/, "\n");
}

export function fundingInstructions(address) {
  return [
    `Public address: ${address}`,
    "Send a small amount of USDC on Tempo mainnet to that address ($1 to $5 is enough to try paid tools).",
    "mppx account fund gives testnet tokens only and does not work for this project's mainnet signer.",
    "Spend is capped: the server default is $2/day (AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS) plus each character's daily budget.",
  ].join("\n");
}

export function dryRunPlan({ binary, account, envPath }) {
  return [
    `Binary: ${binary}`,
    `Account: ${account}`,
    `Would run: ${binary} account list --format json`,
    `If missing, would ask before: ${binary} account create --account ${account}`,
    `Would run: ${binary} account view --account ${account} --format json and print the public address only`,
    `Would ask before writing ${envPath} (AGENT_WORLD_LIVE_MPP=true and MPPX_ACCOUNT=${account} only)`,
    "Would not touch the keychain, .env, or the network in this dry run.",
  ].join("\n");
}

export async function runWalletSetup(io) {
  const args = parseArgs(io.argv);
  const account = accountName(args.account, io.env);
  const binary = resolveMppxBinary({
    env: io.env,
    exists: io.exists,
    bundledPaths: io.bundledPaths,
  });

  if (args.check) {
    const result = await io.run(binary, ["--help"]);
    if (result.code === 0) {
      io.log(`${binary} ok`);
      return 0;
    }
    io.error(result.stderr || `${binary} --help failed`);
    return 1;
  }

  if (args.dryRun) {
    io.log(dryRunPlan({ binary, account, envPath: io.envPath }));
    return 0;
  }

  const listed = await io.run(binary, ["account", "list", "--format", "json"]);
  if (isKeychainUnavailable(listed)) {
    io.error(keychainGuidance(io.platform));
    return 1;
  }
  if (listed.code !== 0) {
    io.error(listed.stderr || listed.stdout || "mppx account list failed");
    return 1;
  }

  const names = parseAccountList(listed.stdout);
  if (!names.includes(account)) {
    const create = await io.confirm(
      `Create mppx account "${account}" in the OS keychain? [y/N] `,
    );
    if (!create) {
      io.error("No account created.");
      return 1;
    }
    const created = await io.run(binary, [
      "account",
      "create",
      "--account",
      account,
    ]);
    if (created.code !== 0) {
      io.error(created.stderr || "mppx account create failed");
      return 1;
    }
  }

  const viewed = await io.run(binary, [
    "account",
    "view",
    "--account",
    account,
    "--format",
    "json",
  ]);
  if (viewed.code !== 0) {
    io.error(viewed.stderr || "mppx account view failed");
    return 1;
  }
  const address = parseAccountAddress(viewed.stdout);
  if (!address) {
    io.error("mppx account view did not include a public address");
    return 1;
  }
  io.log(fundingInstructions(address));

  const enable = await io.confirm("Enable paid tools in .env now? [y/N] ");
  if (!enable) return 0;
  const source = io.exists(io.envPath)
    ? await io.readFile(io.envPath)
    : await io.readFile(io.envExamplePath);
  await io.writeFile(
    io.envPath,
    upsertEnv(source, {
      AGENT_WORLD_LIVE_MPP: "true",
      MPPX_ACCOUNT: account,
    }),
  );
  io.log(`Updated ${io.envPath}`);
  return 0;
}
