import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accountName,
  dryRunPlan,
  isKeychainUnavailable,
  parseAccountAddress,
  parseAccountList,
  parseArgs,
  parseYesNo,
  runWalletSetup,
  upsertEnv,
} from "./wallet-setup.mjs";

const stub = new URL("./mppx-stub.mjs", import.meta.url).pathname;

function runStub(envMode) {
  return (binary, argv) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [binary, ...argv], {
        env: { ...process.env, MPPX_STUB_MODE: envMode },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

describe("wallet-setup parsing", () => {
  it("parses flags and default account", () => {
    assert.deepEqual(parseArgs(["--dry-run", "--account", "demo"]), {
      dryRun: true,
      check: false,
      account: "demo",
    });
    assert.equal(accountName(undefined, {}), "agent-world");
    assert.equal(accountName(undefined, { MPPX_ACCOUNT: "mine" }), "mine");
    assert.equal(parseYesNo(""), false);
    assert.equal(parseYesNo("y"), true);
  });

  it("detects keychain errors and parses account JSON", () => {
    assert.equal(
      isKeychainUnavailable({
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ code: "KEYCHAIN_UNAVAILABLE" }),
      }),
      true,
    );
    assert.deepEqual(
      parseAccountList(JSON.stringify([{ name: "agent-world" }])),
      ["agent-world"],
    );
    assert.equal(
      parseAccountAddress(JSON.stringify({ address: "0xabc" })),
      "0xabc",
    );
  });

  it("preserves unrelated .env lines", () => {
    const next = upsertEnv("LOG_LEVEL=info\nOPENROUTER_API_KEY=keep-me\n", {
      AGENT_WORLD_LIVE_MPP: "true",
      MPPX_ACCOUNT: "agent-world",
    });
    assert.match(next, /LOG_LEVEL=info/);
    assert.match(next, /OPENROUTER_API_KEY=keep-me/);
    assert.match(next, /AGENT_WORLD_LIVE_MPP=true/);
    assert.match(next, /MPPX_ACCOUNT=agent-world/);
  });
});

describe("wallet-setup with stub binary", () => {
  it("exits non-zero on KEYCHAIN_UNAVAILABLE without creating anything", async () => {
    const logs = [];
    const writes = [];
    const code = await runWalletSetup({
      argv: [],
      env: {},
      exists: () => true,
      bundledPaths: [stub],
      envPath: "/tmp/should-not-write.env",
      envExamplePath: "/tmp/example.env",
      platform: "linux",
      log: (line) => logs.push(String(line)),
      error: (line) => logs.push(String(line)),
      confirm: async () => true,
      readFile: () => {
        throw new Error("read");
      },
      writeFile: (path, contents) => writes.push({ path, contents }),
      run: runStub("keychain"),
    });
    assert.equal(code, 1);
    assert.equal(writes.length, 0);
    assert.match(logs.join("\n"), /libsecret-tools/);
    assert.doesNotMatch(logs.join("\n"), /private key|export/i);
  });

  it("prints an existing account address without creating", async () => {
    const logs = [];
    const ran = [];
    const code = await runWalletSetup({
      argv: [],
      env: {},
      exists: () => true,
      bundledPaths: [stub],
      envPath: "/tmp/should-not-write.env",
      envExamplePath: "/tmp/example.env",
      platform: "linux",
      log: (line) => logs.push(String(line)),
      error: (line) => logs.push(String(line)),
      confirm: async () => false,
      readFile: () => "",
      writeFile: () => {
        throw new Error("write");
      },
      run: async (binary, argv) => {
        ran.push(argv.join(" "));
        return runStub("exists")(binary, argv);
      },
    });
    assert.equal(code, 0);
    assert.ok(ran.some((item) => item.includes("account list")));
    assert.ok(!ran.some((item) => item.includes("account create")));
    assert.ok(!ran.some((item) => item.includes("account export")));
    assert.match(logs.join("\n"), /0xabc123publiconly/);
    assert.match(logs.join("\n"), /USDC on Tempo mainnet/);
  });

  it("creates a missing account after confirmation", async () => {
    const ran = [];
    const confirms = ["y", "n"];
    const code = await runWalletSetup({
      argv: ["--account", "agent-world"],
      env: {},
      exists: () => true,
      bundledPaths: [stub],
      envPath: "/tmp/should-not-write.env",
      envExamplePath: "/tmp/example.env",
      platform: "darwin",
      log: () => {},
      error: () => {},
      confirm: async () => parseYesNo(confirms.shift()),
      readFile: () => "",
      writeFile: () => {
        throw new Error("write");
      },
      run: async (binary, argv) => {
        ran.push(argv.join(" "));
        return runStub("missing")(binary, argv);
      },
    });
    assert.equal(code, 0);
    assert.ok(ran.some((item) => item.includes("account create")));
  });

  it("writes .env while preserving unrelated lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wallet-setup-"));
    const envPath = join(dir, ".env");
    const examplePath = join(dir, ".env.example");
    await writeFile(
      examplePath,
      "LOG_LEVEL=info\nOPENROUTER_API_KEY=\nAGENT_WORLD_LIVE_MPP=false\n",
    );
    try {
      const code = await runWalletSetup({
        argv: [],
        env: {},
        exists: (path) => path === stub || path === examplePath,
        bundledPaths: [stub],
        envPath,
        envExamplePath: examplePath,
        platform: "linux",
        log: () => {},
        error: () => {},
        confirm: async () => true,
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, contents) => writeFile(path, contents),
        run: runStub("exists"),
      });
      assert.equal(code, 0);
      const written = await readFile(envPath, "utf8");
      assert.match(written, /LOG_LEVEL=info/);
      assert.match(written, /OPENROUTER_API_KEY=/);
      assert.match(written, /AGENT_WORLD_LIVE_MPP=true/);
      assert.match(written, /MPPX_ACCOUNT=agent-world/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dry-run prints a plan and runs nothing", async () => {
    let ran = 0;
    const logs = [];
    const code = await runWalletSetup({
      argv: ["--dry-run"],
      env: {},
      exists: () => true,
      bundledPaths: [stub],
      envPath: "/tmp/x.env",
      envExamplePath: "/tmp/example.env",
      platform: "linux",
      log: (line) => logs.push(String(line)),
      error: () => {},
      confirm: async () => true,
      readFile: () => "",
      writeFile: () => {
        throw new Error("write");
      },
      run: async () => {
        ran += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(code, 0);
    assert.equal(ran, 0);
    assert.match(logs.join("\n"), /Would not touch the keychain/);
    assert.equal(
      logs.join("\n"),
      dryRunPlan({
        binary: stub,
        account: "agent-world",
        envPath: "/tmp/x.env",
      }),
    );
  });
});
