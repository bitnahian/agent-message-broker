import { describe, expect, it } from "vitest";
import { AppServerClient, parseThreads, findActiveTurnId } from "./app-server-client.js";

describe("app-server-client helpers", () => {
  it("parseThreads accepts top-level array and map shapes (threads/items/data)", () => {
    const a = parseThreads([{ threadId: "a", title: "Alpha" }]);
    expect(a[0]).toMatchObject({ id: "a", name: "Alpha" });
    const b = parseThreads({ threads: [{ id: "b", name: "Bee", cwd: "/x" }] });
    expect(b[0]).toMatchObject({ id: "b", name: "Bee", cwd: "/x" });
    const c = parseThreads({ items: [{ id: "c" }] });
    expect(c[0].id).toBe("c");
    const d = parseThreads({ data: [{ id: "d" }] });
    expect(d[0].id).toBe("d");
    const e = parseThreads({ nothing: [] });
    expect(e).toHaveLength(0);
  });

  it("parseThreads honours threadId over id and exposes activeTurnId", () => {
    const rows = parseThreads([{ id: "dup", threadId: "preferred", status: "ok", activeTurnId: "turn-1" }]);
    expect(rows[0]).toMatchObject({ id: "preferred", threadId: "preferred", status: "ok", activeTurnId: "turn-1" });
  });

  it("findActiveTurnId returns null for empty results", () => {
    expect(findActiveTurnId(null)).toBeNull();
    expect(findActiveTurnId({})).toBeNull();
    expect(findActiveTurnId({ thread: {} })).toBeNull();
  });

  it("findActiveTurnId prefers the explicit v1 activeTurnId", () => {
    expect(findActiveTurnId({ thread: { activeTurnId: "v1-turn" } })).toBe("v1-turn");
  });

  it("findActiveTurnId finds an in-progress v2 turn by id or turnId", () => {
    const byId = findActiveTurnId({ thread: { status: { type: "active" }, turns: [{ id: "tid-1", status: "inProgress" }] } });
    expect(byId).toBe("tid-1");
    const byTurnId = findActiveTurnId({ thread: { status: { type: "active" }, turns: [{ turnId: "tid-2", status: "running" } , { id: "other", status: "completed" }] } });
    expect(byTurnId).toBe("tid-2");
    // no in-progress turn -> null
    expect(findActiveTurnId({ thread: { status: { type: "active" }, turns: [] } })).toBeNull();
  });
});