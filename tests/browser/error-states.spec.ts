import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

/**
 * Failure states (error audit, 2026-10-23). When the server fails every read
 * but /api/me, a page says so and offers Retry; after the fault is lifted,
 * Retry recovers it and no stale banner is left behind. Before the fix a
 * failed background load left an unremovable banner on every page but Loads,
 * and Account and Organization had no Retry at all.
 */
async function signIn(page: Page) {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(response.status()).toBe(200);
}

/** Fail every read except /api/me, so the workspace shell still opens. */
async function failReads(page: Page) {
  await page.route("**/api/**", (route) => {
    const request = route.request();
    if (
      request.method() === "GET" &&
      !new URL(request.url()).pathname.endsWith("/api/me")
    )
      return route.fulfill({ status: 500, json: { error: "INTERNAL_ERROR" } });
    return route.continue();
  });
}

const visibleAlerts = (page: Page) => page.locator(".alert.error:visible");

async function retryAll(page: Page) {
  await page.unroute("**/api/**");
  // Each Retry may reveal or clear another; press until none is left.
  for (let i = 0; i < 4; i++) {
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    if (!(await retry.count())) break;
    await retry.first().click();
    await page.waitForTimeout(600);
  }
}

test("a failed read on Exceptions can be retried and leaves no stale banner", async ({
  page,
}) => {
  await signIn(page);
  await failReads(page);
  await page.goto("/exceptions");
  await expect(visibleAlerts(page).first()).toBeVisible();
  await retryAll(page);
  await expect(visibleAlerts(page)).toHaveCount(0);
  await expect(page.getByRole("table")).toBeVisible();
});

for (const [name, path, ready] of [
  ["Account", "/account", "Account and security"],
  ["Organization", "/organization", "Organization"],
] as const) {
  test(`a failed ${name} page offers Retry and recovers`, async ({ page }) => {
    await signIn(page);
    await failReads(page);
    await page.goto(path);
    await expect(visibleAlerts(page).first()).toBeVisible();
    // A person is never left with an error and no way to try again.
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }).first(),
    ).toBeVisible();
    await retryAll(page);
    await expect(visibleAlerts(page)).toHaveCount(0);
    await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
  });
}

test("editing a vehicle that changed in another tab is refused and says so", async ({
  browser,
  page,
}) => {
  await signIn(page);
  const label = "Conflict " + Date.now().toString().slice(-6);
  await page.goto("/fleet");
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const add = page.getByRole("dialog", { name: "Add vehicle" });
  await add.getByLabel("Unit name").fill(label);
  await add.getByRole("button", { name: "Add vehicle", exact: true }).click();
  await expect(add).toHaveCount(0);

  // A second tab opens the editor and holds the old version ...
  const other = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const stale = await other.newPage();
  await stale.goto("/fleet");
  const row = (p: Page) => p.getByRole("row", { name: new RegExp(label) });
  await row(stale).getByRole("button", { name: /^Edit/ }).click();
  const staleEdit = stale.getByRole("dialog", { name: "Edit vehicle" });

  // ... while the first tab saves a change.
  await row(page).getByRole("button", { name: /^Edit/ }).click();
  const edit = page.getByRole("dialog", { name: "Edit vehicle" });
  await edit.getByLabel("Plate (optional)").fill("AAA111");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(row(page)).toContainText("AAA111");

  // The stale save is refused, in words that fit a vehicle, and changes nothing.
  await staleEdit.getByLabel("Plate (optional)").fill("BBB222");
  await staleEdit.getByRole("button", { name: "Save changes" }).click();
  const alert = staleEdit.locator(".alert.error");
  await expect(alert).toContainText("Someone just updated this");
  await expect(alert).not.toContainText(/load/i);
  await stale.reload();
  await expect(row(stale)).toContainText("AAA111");
  await expect(row(stale)).not.toContainText("BBB222");
  await other.close();
});

test("an address that is not available says so without offering a useless Retry", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/loads/00000000-0000-4000-8000-000000000000");
  const alert = page.locator(".alert.error:visible");
  await expect(alert).toContainText(/couldn.t find that/);
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("the queue strip stays keyboard-scrollable while its tabs are busy", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".queueTabs")).toBeVisible();
  // Hold the load-detail request so the workspace is busy (every tab is
  // disabled) while it is in flight, as it is for a moment when a load opens.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/loads\/[0-9a-f-]{36}$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.locator(".loadCard").first().click();
  await expect(page.getByRole("button", { name: /^Delivered/ })).toBeDisabled();
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            c: string,
            o: object,
          ) => Promise<{ violations: { id: string }[] }>;
        };
      }
    ).axe.run(".queueTabs", { runOnly: ["scrollable-region-focusable"] });
    return result.violations.map((v) => v.id);
  });
  release();
  expect(violations).toEqual([]);
});
