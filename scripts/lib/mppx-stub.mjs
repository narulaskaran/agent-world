#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const mode = process.env.MPPX_STUB_MODE ?? "exists";

if (args === "--help" || args.endsWith(" --help")) {
  console.log("mppx stub help");
  process.exit(0);
}

if (mode === "keychain") {
  console.error(
    JSON.stringify({
      code: "KEYCHAIN_UNAVAILABLE",
      message: "No secret service",
    }),
  );
  process.exit(1);
}

if (args.includes("account list")) {
  if (mode === "missing") console.log(JSON.stringify([]));
  else console.log(JSON.stringify([{ name: "agent-world" }]));
  process.exit(0);
}

if (args.includes("account create")) {
  console.log(JSON.stringify({ name: "agent-world", created: true }));
  process.exit(0);
}

if (args.includes("account view")) {
  console.log(JSON.stringify({ address: "0xabc123publiconly" }));
  process.exit(0);
}

if (args.includes("account export")) {
  console.error("stub refused export");
  process.exit(2);
}

console.error(`unhandled stub args: ${args}`);
process.exit(1);
