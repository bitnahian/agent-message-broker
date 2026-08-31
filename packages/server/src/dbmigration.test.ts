import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "./db.js";

describe("migrateGwsToGoogle (data migration)", () => {
  it("rewrites gws sources to kind google with command joined into api", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "amb-mig-")), "broker.db");
    const db = createDb(path);
    const gwsOptions = JSON.stringify({
      command: ["drive", "files", "list"],
      params: { q: "trashed = false" },
      itemsPath: "files",
      fingerprintField: "modifiedTime",
      intervalMs: 120000,
    });
    db.prepare(
      "INSERT INTO topics (id, name, retainN, createdAt) VALUES ('t1', 'doc', 100, 1)",
    ).run();
    db.prepare(
      "INSERT INTO sources (id, topicId, kind, options, enabled, createdAt) VALUES ('s1', 't1', 'gws', ?, 1, 1)",
    ).run(gwsOptions);
    // malformed options JSON must be left alone, not crash migration
    db.prepare(
      "INSERT INTO sources (id, topicId, kind, options, enabled, createdAt) VALUES ('s2', 't1', 'gws', '{not json', 1, 1)",
    ).run();

    // reopen: migrate() re-runs over existing data
    const db2 = createDb(path);
    const rows = db2.prepare("SELECT id, kind, options FROM sources ORDER BY id").all() as {
      id: string;
      kind: string;
      options: string;
    }[];

    expect(rows[0]).toMatchObject({ id: "s1", kind: "google" });
    const o = JSON.parse(rows[0]!.options);
    expect(o.api).toBe("drive.files.list");
    expect(o.command).toBeUndefined();
    expect(o.params).toEqual({ q: "trashed = false" });
    expect(o.fingerprintField).toBe("modifiedTime");
    expect(rows[1]).toMatchObject({ id: "s2", kind: "gws" }); // untouched
  });
});
