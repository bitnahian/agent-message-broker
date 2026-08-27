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
}
