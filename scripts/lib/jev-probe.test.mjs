import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JEV_MODEL,
  OPENROUTER_DECISIONS_URL,
  dryRunText,
  parseArgs,
  parseDotenv,
  parseProbeResponse,
  probeRequest,
  redact,
  runJevProbe,
} from "./jev-probe.mjs";

const KEY = "sk-test-not-real";

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const successBody = {
  id: "dec_probe",
  model: "typesafe/jev-1.13-test",
  provider: "TypeSafe",
  answers: { alive: { type: "noul", noul: 0.91 } },
  usage: { input_tokens: 40, output_tokens: 4, cost: 0.000019992 },
};

describe("jev-probe parsing", () => {
  it("parses flags, dotenv, and a successful noul body", () => {
    assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
    assert.equal(
      parseDotenv("OPENROUTER_API_KEY=from-file\n# c\n").OPENROUTER_API_KEY,
      "from-file",
    );
    const parsed = parseProbeResponse(successBody);
    assert.equal(parsed.model, "typesafe/jev-1.13-test");
    assert.equal(parsed.noul, 0.91);
    assert.equal(parsed.cost, 0.000019992);
  });

  it("rejects unexpected shapes", () => {
    assert.throws(() =>
      parseProbeResponse({
        answers: { alive: { type: "choice", choice: "x" } },
      }),
    );
    assert.throws(() => parseProbeResponse("nope"));
    assert.throws(() => parseProbeResponse({ model: "x", answers: {} }));
  });
});

describe("jev-probe run", () => {
  it("prints a redacted dry-run request and does not fetch", async () => {
    const lines = [];
    let fetched = false;
    const code = await runJevProbe({
      argv: ["--dry-run"],
      env: {
        OPENROUTER_API_KEY: KEY,
        AGENT_WORLD_JEV_MODEL: DEFAULT_JEV_MODEL,
      },
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse(200, successBody);
      },
      log: (line) => lines.push(line),
    });
    assert.equal(code, 0);
    assert.equal(fetched, false);
    const printed = lines.join("\n");
    assert.match(printed, new RegExp(OPENROUTER_DECISIONS_URL));
    assert.match(printed, /Bearer \[redacted\]/);
    assert.doesNotMatch(printed, new RegExp(KEY));
    assert.match(printed, /"type": "noul"/);
  });

  it("prints model, answer, latency, and usage.cost on success", async () => {
    const lines = [];
    const errors = [];
    let url;
    let auth;
    const code = await runJevProbe({
      argv: [],
      env: { OPENROUTER_API_KEY: KEY },
      now: (() => {
        let t = 1000;
        return () => {
          const value = t;
          t += 25;
          return value;
        };
      })(),
      fetchImpl: async (input, init) => {
        url = String(input);
        auth = new Headers(init?.headers).get("authorization");
        return jsonResponse(200, successBody);
      },
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
    });
    assert.equal(code, 0);
    assert.equal(url, OPENROUTER_DECISIONS_URL);
    assert.equal(auth, `Bearer ${KEY}`);
    assert.deepEqual(lines, [
      "model: typesafe/jev-1.13-test",
      "answer: 0.91",
      "latency_ms: 25",
      "usage.cost: 0.000019992",
    ]);
    assert.equal(errors.length, 0);
    assert.doesNotMatch(lines.join("\n"), new RegExp(KEY));
  });

  it("exits non-zero on HTTP 401 without printing the key", async () => {
    const errors = [];
    const code = await runJevProbe({
      argv: [],
      env: { OPENROUTER_API_KEY: KEY },
      fetchImpl: async () =>
        jsonResponse(401, { error: { message: `Invalid key ${KEY}` } }),
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /OpenRouter 401:/);
    assert.doesNotMatch(errors.join("\n"), new RegExp(KEY));
    assert.match(errors.join("\n"), /\[redacted\]/);
  });

  it("exits non-zero on a malformed body", async () => {
    const errors = [];
    const code = await runJevProbe({
      argv: [],
      env: { OPENROUTER_API_KEY: KEY },
      fetchImpl: async () => jsonResponse(200, { id: "x" }),
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /unexpected Decisions response shape/);
  });

  it("refuses to run without a key unless dry-run", async () => {
    const errors = [];
    const code = await runJevProbe({
      argv: [],
      env: {},
      fetchImpl: async () => {
        throw new Error("network");
      },
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /OPENROUTER_API_KEY/);
  });

  it("redacts the key in helper output", () => {
    const request = probeRequest({ OPENROUTER_API_KEY: KEY });
    assert.equal(redact(`denied ${KEY}`, KEY), "denied [redacted]");
    assert.doesNotMatch(dryRunText(request), new RegExp(KEY));
  });
});
