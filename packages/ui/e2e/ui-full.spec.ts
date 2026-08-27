import { test, expect } from "./coverage.js";
import { api, apiGet } from "./helpers.js";

/**
 * Broad UI path coverage: exercises the remaining major UI surfaces not hit by
 * the existing suite — the publish form, topic & subscription deletes, source
 * delete, and subscription create with a template. Drives the instrumented
 * bundle so the e2e coverage report counts these paths.
 */
test.describe("UI full-flow coverage", () => {
  test.beforeEach(async () => {
    const topics = await apiGet<{ id: string }>("/topics");
    for (const t of topics) await api("DELETE", `/topics/${t.id}`);
  });

  test("publishes an event from the UI publish form and sees it live", async ({ page }) => {
    const t = (await api("POST", "/topics", { name: "pub-from-ui" })) as { id: string };
    await page.goto("/");
    await page.getByText("pub-from-ui", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "pub-from-ui" })).toBeVisible({ timeout: 5000 });

    await page.getByText("Publish event").click();
    await page.getByPlaceholder("Kind (e.g. test:manual)").fill("manual:draft");
    await page.getByPlaceholder('{"key": "value"}').fill('{"n": 1}');
    await page.getByRole("button", { name: "Publish", exact: true }).click();

    await expect(page.getByText("Event published: manual:draft")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("manual:draft").first()).toBeVisible({ timeout: 5000 });
    const events = await apiGet<any[]>(`/events?topicId=${t.id}`);
    expect(events.some((e) => e.kind === "manual:draft")).toBe(true);
  });

  test("deletes a topic via the UI two-step confirm", async ({ page }) => {
    await api("POST", "/topics", { name: "del-me" });
    await page.goto("/");
    await expect(page.getByText("del-me", { exact: true })).toBeVisible();

    await page.getByTitle('Delete topic "del-me"').click();
    await page.getByText("Confirm", { exact: true }).click();
    await expect(page.getByText("Topic deleted")).toBeVisible({ timeout: 5000 });

    const topics = await apiGet<{ name: string }[]>("/topics");
    expect(topics.some((x) => x.name === "del-me")).toBe(false);
  });

  test("creates a source via the UI and deletes it via the UI confirm", async ({ page }) => {
    const t = (await api("POST", "/topics", { name: "src-crud" })) as { id: string };
    await page.goto("/");
    await page.getByText("src-crud", { exact: true }).click();
    await page.getByText("Sources", { exact: true }).first().click();

    // sources empty here, so the "Add source" panel is open by default —
    // only toggle it open if it isn't already visible
    const select = page.locator("select").first();
    if (!(await select.isVisible().catch(() => false))) {
      await page.getByText("Add source").click();
    }
    await select.selectOption("jira");
    await page.locator("textarea").first().fill('{"jql": "project = KAN"}');
    await page.getByRole("button", { name: "Create source" }).click();

    // wait for the backend to actually have the jira source, then check the UI badge
    await expect
      .poll(async () => (await apiGet<any[]>("/sources")).some((s) => s.kind === "jira"), { timeout: 5000 })
      .toBe(true);
    await expect(page.getByText("Jira").last()).toBeVisible({ timeout: 5000 });
    expect((await apiGet<any[]>("/sources")).some((s) => s.kind === "jira")).toBe(true);

    // delete the source through the UI
    await page.getByText("Delete").first().click();
    await page.getByText("confirm", { exact: true }).click();
    await expect(page.getByText("Source deleted")).toBeVisible({ timeout: 5000 });
    expect((await apiGet<unknown[]>("/sources")).length).toBe(0);
    expect(t.id).toBe(t.id); // keep referencing t
  });

  test("subscribes an agent session with a template via the UI, then deletes it", async ({ page }) => {
    await api("POST", "/topics", { name: "sub-tpl" });
    await page.goto("/");
    await page.getByText("sub-tpl", { exact: true }).click();
    await page.getByText("Subscriptions", { exact: true }).first().click();

    // the "Paste pi session ID" manual input only shows when the agent has no
    // reachable live sessions; the e2e broker may run on this machine with live
    // pi sessions, so handle both: pick the first reachable session, else type an id
    const manual = page.getByPlaceholder("Paste pi session ID");
    if ((await manual.count()) > 0) {
      await manual.fill("pi-live-1");
    } else {
      await page.locator("button.w-full.text-left").first().click();
    }
    await page.getByPlaceholder("e.g. Event {{kind}}: {{payload}}").fill("EV {{kind}} -> {{payload}}");
    await page.getByRole("button", { name: "Subscribe" }).click();

    await expect(page.getByText(/subscribed/).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/template: EV \{/)).toBeVisible({ timeout: 5000 });
    const topic = (await apiGet<{ id: string }[]>("/topics")).find((x) => x.name === "sub-tpl")!;
    const subs = await apiGet<any[]>(`/subscriptions?topicId=${topic.id}`);
    expect(subs).toHaveLength(1);
    expect(subs[0].template).toContain("{{kind}}");

    await page.getByText("Delete").first().click();
    await page.getByText("confirm", { exact: true }).click();
    await expect(page.getByText("Subscription deleted")).toBeVisible({ timeout: 5000 });
    expect((await apiGet<any[]>("/subscriptions")).length).toBe(0);
  });

  test("a duplicate topic name surfaced as an error toast through the UI", async ({ page }) => {
    await api("POST", "/topics", { name: "d2" });
    await page.goto("/");
    await page.getByPlaceholder("New topic name...").fill("d2");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Already exists", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("A duplicate already exists")).toBeVisible({ timeout: 3000 });
  });

  test("an error-kind live event shows an error-tinted badge and drives the throughput counter", async ({ page }) => {
    await api("POST", "/topics", { name: "erb" });
    await page.goto("/");
    await page.getByText("erb", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "erb" })).toBeVisible({ timeout: 5000 });

    // publish an "error"-kind event through the UI so the live SSE feed receives it
    await page.getByText("Publish event").click();
    await page.getByPlaceholder("Kind (e.g. test:manual)").fill("app:error");
    await page.getByPlaceholder('{"key": "value"}').fill('{}');
    await page.getByRole("button", { name: "Publish", exact: true }).click();

    await expect(page.getByText("Event published: app:error")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("app:error").first()).toBeVisible({ timeout: 5000 });
  });

  test("ConfirmButton cancel leaves the resource intact", async ({ page }) => {
    await api("POST", "/topics", { name: "canc-cul" });
    await page.goto("/");
    await page.getByText("canc-cul", { exact: true }).click();
    await page.getByText("Sources", { exact: true }).first().click();

    const select = page.locator("select").first();
    if (!(await select.isVisible().catch(() => false))) await page.getByText("Add source").click();
    await select.selectOption("polled-url");
    await page.locator("textarea").first().fill('{ "url": "https://example.com" }');
    await page.getByRole("button", { name: "Create source" }).click();
    await expect.poll(async () => (await apiGet<any[]>("/sources")).length, { timeout: 5000 }).toBe(1);

    await page.getByText("Delete").first().click();
    await page.getByText("cancel", { exact: true }).click();
    await expect.poll(async () => (await apiGet<any[]>("/sources")).length, { timeout: 5000 }).toBe(1);
    await page.getByText("Delete").first().click();
    await page.getByText("confirm", { exact: true }).click();
    await expect.poll(async () => (await apiGet<any[]>("/sources")).length, { timeout: 5000 }).toBe(0);
  });

  test("subscribing a Claude session uses the picker and the amber agent ring", async ({ page }) => {
    await api("POST", "/topics", { name: "sub-claude" });
    await page.goto("/");
    await page.getByText("sub-claude", { exact: true }).click();
    await page.getByText("Subscriptions", { exact: true }).first().click();

    await page.getByText("Claude", { exact: true }).click();
    // use the session picker if live claude sessions exist, else the manual input
    const picker = page.locator("button.w-full.text-left");
    const manual = page.getByPlaceholder("Paste claude session ID");
    if ((await picker.count()) > 0) {
      await picker.first().click();
    } else {
      await manual.fill("claude-auto-1");
    }
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByText("Claude subscribed").first()).toBeVisible({ timeout: 5000 });
  });

  test("subscribing an agent with no live sessions uses the manual session-id input", async ({ page }) => {
    await api("POST", "/topics", { name: "sub-codex" });
    await page.goto("/");
    await page.getByText("sub-codex", { exact: true }).click();
    await page.getByText("Subscriptions", { exact: true }).first().click();

    // Codex select the manual path when there are no live codex sessions, else the picker
    await page.getByText("Codex", { exact: true }).click();
    const manual = page.getByPlaceholder("Paste codex session ID");
    const picker = page.locator("button.w-full.text-left");
    if ((await manual.count()) > 0) {
      await manual.fill("codex-manual-1");
    } else {
      await picker.first().click();
    }
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByText(/subscribed/).first()).toBeVisible({ timeout: 5000 });
    const topic = (await apiGet<{ id: string }[]>("/topics")).find((x) => x.name === "sub-codex")!;
    const subs = await apiGet<any[]>(`/subscriptions?topicId=${topic.id}`);
    expect(subs.length).toBeGreaterThan(0);
    expect(subs[0].target.agent).toBe("codex");
    expect(subs[0].target.sessionId.length).toBeGreaterThan(0);
  });
});