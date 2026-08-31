#!/usr/bin/env node
import { bootstrap } from "../dist/server.js";

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
