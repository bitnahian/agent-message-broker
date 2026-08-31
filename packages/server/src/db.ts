import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function createDb(path: string = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  retainN INTEGER NOT NULL DEFAULT 100,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  topicId TEXT NOT NULL REFERENCES topics(id),
  kind TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  topicId TEXT NOT NULL REFERENCES topics(id),
  agent TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  label TEXT,
  template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  topicId TEXT NOT NULL REFERENCES topics(id),
  sourceId TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  detectedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topicId, detectedAt);
CREATE TABLE IF NOT EXISTS source_state (
  sourceId TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (sourceId, key)
);
CREATE TABLE IF NOT EXISTS deliveries (
  eventId TEXT NOT NULL,
  subscriptionId TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  attemptedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON deliveries(eventId);
CREATE INDEX IF NOT EXISTS idx_deliveries_sub ON deliveries(subscriptionId);
`);
  migrateGwsToGoogle(db);
}

/**
 * Data migration: `gws` sources (shelling out to the gws CLI) move to the
 * googleapis-backed `google` kind (ADR-0006). Options translate 1:1:
 * `command: ["drive","files","list"]` becomes `api: "drive.files.list"`;
 * params/itemsPath/idField/fingerprintField/intervalMs carry over as-is.
 * Emitted event kinds stay `gws:<service>:<new|changed>`, so subscriptions
 * and templates are unaffected.
 */
function migrateGwsToGoogle(db: Db): void {
  const rows = db.prepare("SELECT id, options FROM sources WHERE kind = 'gws'").all() as { id: string; options: string }[];
  for (const row of rows) {
    try {
      const o = JSON.parse(row.options) as Record<string, unknown>;
      if (Array.isArray(o.command)) {
        o.api = o.command.join(".");
        delete o.command;
      }
      db.prepare("UPDATE sources SET kind = 'google', options = ? WHERE id = ?").run(JSON.stringify(o), row.id);
    } catch {
      // malformed options JSON: leave the row untouched rather than guess
    }
  }
}
