#!/usr/bin/env node
// Launcher: check Node version before loading modules that need node:sqlite (Node >= 22.5).
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  process.stderr.write(`trolley plugin requires Node >= 22.5 (built-in node:sqlite); found ${process.version}. Point mcp.json "command" at a newer node.\n`);
  process.exit(1);
}
const { startStdio } = await import("./main.mjs");
startStdio();
