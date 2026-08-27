import { test, expect } from "./coverage.js";
import { api, apiGet } from "./helpers.js";

test.describe("UI rendering", () => {
  // Clean up all topics before running UI tests
  test.beforeAll(async () => {
    const topics = await apiGet<{ id: string }>("/topics");
    for (const t of topics) await api("DELETE", `/topics/${t.id}`);
  });

  test("app shell renders the Local Exchange dashboard", async ({ page }) => {
    await page.goto("/");
    // Title renders
    await expect(page.getByText("agent-message-broker")).toBeVisible();
    // Create topic form present in sidebar
    await expect(page.getByPlaceholder("New topic name...")).toBeVisible();
    // Three agent indicators visible in top bar
    await expect(page.getByText("pi:", { exact: false })).toBeVisible();
    await expect(page.getByText("Claude:", { exact: false })).toBeVisible();
    await expect(page.getByText("Codex:", { exact: false })).toBeVisible();
  });

  test("first-run shows the guided launchpad", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("The Local Exchange")).toBeVisible();
    // Three steps visible
    await expect(page.getByText("Create a topic")).toBeVisible();
    await expect(page.getByText("Add a source")).toBeVisible();
    await expect(page.getByText("Subscribe an agent")).toBeVisible();
  });

  test("launchpad 'Create your first topic' focuses the name input when empty — no error toast", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("The Local Exchange")).toBeVisible();

    // Click with no name typed: must focus the sidebar input, not POST garbage
    await page.getByRole("button", { name: "Create your first topic" }).click();
    await expect(page.getByPlaceholder("New topic name...")).toBeFocused();
    // No error toast may appear
    await expect(page.getByText("Request failed", { exact: true })).toBeHidden();
    await expect(page.getByText("Authentication failed", { exact: true })).toBeHidden();

    // Now type a name and click again: topic is created
    await page.getByPlaceholder("New topic name...").fill("launchpad-topic");
    await page.getByRole("button", { name: "Create your first topic" }).click();
    await expect(page.getByRole("heading", { name: "launchpad-topic" })).toBeVisible({ timeout: 5000 });
  });

  test("creating a topic via the UI navigates into the detail panel", async ({ page }) => {
    await page.goto("/");
    const nameField = page.getByPlaceholder("New topic name...");
    await nameField.fill("ui-e2e-topic");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // The topic appears in the detail header after selection
    await expect(page.getByRole("heading", { name: "ui-e2e-topic" })).toBeVisible();
    // The detail panel tabs render
    await expect(page.getByText("Events", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Sources", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Subscriptions", { exact: true }).first()).toBeVisible();
  });

  test("publishing an event via the API makes it visible in the retained events list", async ({ page }) => {
    // Create topic
    await page.goto("/");
    await page.getByPlaceholder("New topic name...").fill("ev-topic");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "ev-topic" })).toBeVisible();

    // Publish event via the API
    const topics = await apiGet<{ id: string; name: string }>("/topics");
    const t = topics.find((x) => x.name === "ev-topic")!;

    await api("POST", "/events", { topicId: t.id, kind: "e2e:ui", payload: { msg: "hello" } });

    // Click Browse retained to see past events
    await page.getByRole("button", { name: "Browse retained" }).click();
    await page.waitForTimeout(500);
    // The event should appear in the retained list
    await expect(page.getByText("e2e:ui")).toBeVisible({ timeout: 5000 });
  });
});
