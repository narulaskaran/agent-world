import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4319;
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const CHARACTER = {
  name: "Moss",
  personality: "Curious about tiny gardens and gentle conversations.",
  model: "z-ai/glm-5.3-flash",
  dailyBudgetMicros: 500_000,
  decisionIntervalSeconds: 60,
  firstMission: "explore",
};

const pass = (name) => {
  console.log(`pass: ${name}`);
};

const fail = (name, detail) => {
  throw new Error(`${name}: ${detail}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(200);
  }
  fail("health", `timed out waiting for ${BASE}/health`);
}

function spawnServer(databasePath) {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.AGENT_WORLD_LIVE_MPP;
  env.AGENT_WORLD_HOST = HOST;
  env.AGENT_WORLD_SERVER_PORT = String(PORT);
  env.AGENT_WORLD_DATABASE = databasePath;
  env.LOG_LEVEL = env.LOG_LEVEL ?? "error";

  return spawn("pnpm", ["--filter", "@agent-world/server", "start"], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

async function stopServer(child) {
  if (!child?.pid || child.exitCode != null) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode != null) resolve(undefined);
    else child.once("exit", () => resolve(undefined));
  });
  killProcessTree(child, "SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(3_000).then(() => true),
  ]);
  if (timedOut && child.exitCode == null) killProcessTree(child, "SIGKILL");
  await Promise.race([exited, sleep(2_000)]);
}

async function waitForSnapshot(name, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${HOST}:${PORT}/ws`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for snapshot"));
    }, timeoutMs);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        const names = (message?.payload?.characters ?? []).map(
          (character) => character.name,
        );
        if (message?.type === "snapshot" && names.includes(name)) {
          clearTimeout(timer);
          socket.close();
          resolve(message.payload);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-world-smoke-"));
  const databasePath = join(tempDir, "world.db");
  const child = spawnServer(databasePath);
  try {
    await waitForHealth();
    pass("health");

    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    if (
      !home.ok ||
      !/text\/html/i.test(home.headers.get("content-type") ?? "") ||
      !/<html/i.test(html)
    )
      fail(
        "html",
        `expected HTML from GET /, got ${home.status} ${home.headers.get("content-type")}`,
      );
    pass("html");

    const created = await fetch(`${BASE}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHARACTER),
    });
    if (created.status !== 201)
      fail(
        "create",
        `expected 201, got ${created.status} ${await created.text()}`,
      );
    const character = await created.json();
    const createdIntent = character.intent;
    const createdX = character.x;
    const createdY = character.y;
    pass("create");

    await waitForSnapshot(CHARACTER.name);
    pass("websocket snapshot");

    const inspected = await fetch(`${BASE}/api/characters/${CHARACTER.name}`);
    if (!inspected.ok) fail("inspect", `expected 200, got ${inspected.status}`);
    const inspectBody = await inspected.json();
    if (inspectBody?.character?.name !== CHARACTER.name)
      fail("inspect", "inspect payload did not include the character");
    pass("inspect");

    await sleep(8_000);
    const later = await fetch(`${BASE}/api/state`);
    const snapshot = await later.json();
    const live = (snapshot.characters ?? []).find(
      (item) => item.name === CHARACTER.name,
    );
    if (!live) fail("movement", "character missing from snapshot after wait");
    const moved =
      live.intent !== createdIntent ||
      live.x !== createdX ||
      live.y !== createdY;
    if (!moved)
      fail(
        "movement",
        `intent/position unchanged (${live.intent} @ ${live.x},${live.y})`,
      );
    pass("movement");
  } finally {
    await stopServer(child);
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
