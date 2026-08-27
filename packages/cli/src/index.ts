#!/usr/bin/env node
import { BrokerClient } from "./client.js";
import { createProgram } from "./program.js";

const program = createProgram(new BrokerClient());
program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
