#!/usr/bin/env node
// Package-name bin so `npx agent-message-broker` works (npx resolves the bin
// matching the package name). No args -> start the broker; args -> forward to
// the `amb` CLI. So:
//   npx agent-message-broker                  -> broker + UI at 127.0.0.1:4733
//   npx agent-message-broker topics create x  -> CLI command
const args = process.argv.slice(2);

if (args.length === 0) {
  const { bootstrap } = await import("../dist/server.js");
  bootstrap().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  await import("../dist/cli.js");
}
