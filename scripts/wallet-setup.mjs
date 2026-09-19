#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  bundledMppxPaths,
  parseYesNo,
  repoRootFrom,
  runWalletSetup,
} from "./lib/wallet-setup.mjs";

const root = repoRootFrom(import.meta.url);

function run(binary, argv) {
  return new Promise((resolve) => {
    const child = spawn(binary, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function confirm(prompt) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return parseYesNo(answer);
  } finally {
    rl.close();
  }
}

const code = await runWalletSetup({
  argv: process.argv.slice(2),
  env: process.env,
  exists: existsSync,
  bundledPaths: bundledMppxPaths(root),
  envPath: join(root, ".env"),
  envExamplePath: join(root, ".env.example"),
  platform: process.platform,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  confirm,
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, contents) => writeFileSync(path, contents),
  run,
});

process.exitCode = code;
