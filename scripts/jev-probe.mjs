#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRootFrom } from "./lib/wallet-setup.mjs";
import { parseDotenv, runJevProbe } from "./lib/jev-probe.mjs";

const root = repoRootFrom(import.meta.url);
const envPath = join(root, ".env");
const fileEnv = existsSync(envPath)
  ? parseDotenv(readFileSync(envPath, "utf8"))
  : {};

const code = await runJevProbe({
  argv: process.argv.slice(2),
  env: process.env,
  fileEnv,
});

process.exitCode = code;
