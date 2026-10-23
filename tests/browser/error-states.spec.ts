import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

/**
 * Failure states (error audit, 2026-10-23). When the server fails every read
 * but /api/me, a page says so and offers Retry; after the fault is lifted,
 * Retry recovers it and no stale banner is left behind. Before the fix a
 * failed background load left an unremovable banner on every page but Loads,
 * and Account and Organization had no Retry at all.
 */
async function signIn(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email,
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
  await page.goto("/exceptions", { waitUntil: "networkidle" });
  // The shell's loads request is debounced; let it finish before counting.
  await page.waitForTimeout(600);
  await expect(visibleAlerts(page).first()).toBeVisible();
  // One failure, one banner: the page's own, not a second one from the shell.
  await expect(visibleAlerts(page)).toHaveCount(1);
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

test("a loads failure seen from another page is retried when Loads opens", async ({
  page,
}) => {
  await signIn(page);
  await failReads(page);
  await page.goto("/exceptions", { waitUntil: "networkidle" });
  // The shell's loads request is debounced; let it finish before counting.
  await page.waitForTimeout(600);
  await expect(visibleAlerts(page)).toHaveCount(1);
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(visibleAlerts(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Loads", exact: true }).click();
  await expect(page.locator(".loadCard").first()).toBeVisible();
  await expect(visibleAlerts(page)).toHaveCount(0);
});

for (const email of ["carrier@relay.test", "driver@relay.test"]) {
  test(`${email} opening a page the role cannot use fires no requests for it`, async ({
    page,
  }) => {
    await signIn(page, email);
    const refused: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/") && r.status() === 404)
        refused.push(new URL(r.url()).pathname);
    });
    for (const path of [
      "/audit",
      "/organization",
      "/assistant",
      "/prospects",
    ]) {
      await page.goto(path);
      await expect(page.locator(".alert.error:visible")).toContainText(
        /couldn.t find that/,
      );
    }
    // The person is told it is unavailable and no page asked for its data.
    expect(refused).toEqual([]);
  });
}

test("a failed people search says so, and an empty one says no one matches", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/inbox");
  const inbox = page.getByRole("region", { name: "Inbox" });
  await inbox.getByRole("button", { name: "New message" }).click();
  const composer = inbox.getByRole("form", { name: "Write a message" });
  const find = composer.getByRole("searchbox", { name: "Find people" });

  // Nobody has this name: a plain, quiet answer, not an error.
  await find.fill("zzzz-nobody-has-this-name");
  await expect(composer.getByText(/No one matches/)).toBeVisible();
  await expect(composer.locator(".alert.error")).toHaveCount(0);

  // The lookup fails: an error with Retry, never "no one matches".
  await page.route(/\/api\/contacts\?/, (route) =>
    route.fulfill({ status: 500, json: { error: "INTERNAL_ERROR" } }),
  );
  await find.fill("Jordan");
  await expect(composer.locator(".alert.error")).toBeVisible();
  await expect(composer.getByText(/No one matches/)).toHaveCount(0);

  // Lifting the fault and retrying shows the matches.
  await page.unroute(/\/api\/contacts\?/);
  await composer.getByRole("button", { name: "Retry" }).click();
  await expect(
    composer.getByRole("button", { name: /^Add Jordan/ }),
  ).toBeVisible();
  await expect(composer.locator(".alert.error")).toHaveCount(0);
});

test("an export that waits more than two minutes says so without alarm", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/reports");
  let status: Record<string, unknown> = {};
  await page.route(/\/api\/reports\/exports\/[0-9a-f-]{36}$/, (route) =>
    route.fulfill({ json: status }),
  );
  // Waiting two minutes: still queued, so say it is slow without alarm.
  status = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "queued",
    row_count: null,
    error_code: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  };
  await page.locator("summary", { hasText: "Larger exports" }).click();
  await page.getByRole("button", { name: "Prepare larger export" }).click();
  await expect(page.getByText(/taking longer than expected/)).toBeVisible();
  await expect(page.locator(".alert.error")).toHaveCount(0);
});

test("a stalled export is shown as failed with its reason", async ({
  page,
}) => {
  await signIn(page);
  await page.route(/\/api\/reports\/exports\/[0-9a-f-]{36}$/, (route) =>
    route.fulfill({
      json: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "failed",
        row_count: null,
        error_code: "EXPORT_STALLED",
        created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
      },
    }),
  );
  await page.goto("/reports?export_id=11111111-1111-4111-8111-111111111111");
  await page.locator("summary", { hasText: "Larger exports" }).click();
  await expect(page.locator(".alert.error")).toContainText(/never started/);
  await expect(page.getByText(/Export failed/)).toBeVisible();
});

/** Expire the session server-side, as a timeout would, by dropping the cookie. */
async function expireSession(page: Page) {
  await page.context().clearCookies();
}

test("a session that expires mid-task keeps the dialog and its typed text", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/fleet");
  const label = "Expiry " + Date.now().toString().slice(-6);
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const add = page.getByRole("dialog", { name: "Add vehicle" });
  await add.getByLabel("Unit name").fill(label);
  await add.getByLabel("Plate (optional)").fill("keep me");

  await expireSession(page);
  await add.getByRole("button", { name: "Add vehicle", exact: true }).click();

  // Sign-in appears over the workspace and says why.
  const overlay = page.getByRole("dialog", { name: "Session expired" });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("what you were working on is still here");

  // A wrong password stays in the overlay with its message.
  await overlay
    .getByLabel("Email", { exact: true })
    .fill("dispatcher@relay.test");
  await overlay
    .getByLabel("Password", { exact: true })
    .fill("not-the-password");
  await overlay.getByRole("button", { name: /^Sign in/ }).click();
  await expect(overlay.locator(".alert.error")).toContainText(/don.t match/);
  await expect(overlay).toBeVisible();

  // The right one goes back to the same dialog, text intact.
  await overlay
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await overlay.getByRole("button", { name: /^Sign in/ }).click();
  await expect(overlay).toHaveCount(0);
  await expect(add).toBeVisible();
  await expect(add.getByLabel("Unit name")).toHaveValue(label);
  await expect(add.getByLabel("Plate (optional)")).toHaveValue("keep me");

  // Saving now works, with the same text.
  await add.getByRole("button", { name: "Add vehicle", exact: true }).click();
  await expect(
    page.getByRole("row", { name: new RegExp(label) }),
  ).toContainText("KEEP ME");
});

test("someone else signing in after an expiry gets a fresh page, not the last person's screen", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/fleet");
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  await page
    .getByRole("dialog", { name: "Add vehicle" })
    .getByLabel("Unit name")
    .fill("Private to the first person");
  await expireSession(page);
  await page
    .getByRole("dialog", { name: "Add vehicle" })
    .getByRole("button", { name: "Add vehicle", exact: true })
    .click();
  const overlay = page.getByRole("dialog", { name: "Session expired" });
  await expect(overlay).toBeVisible();
  await overlay.getByLabel("Email", { exact: true }).fill("driver@relay.test");
  await overlay
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await overlay.getByRole("button", { name: /^Sign in/ }).click();
  // A driver's own workspace, with none of the first person's dialog or text.
  await expect(
    page.getByRole("dialog", { name: "Session expired" }),
  ).toHaveCount(0);
  await expect(page.getByText("Private to the first person")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Add vehicle" })).toHaveCount(
    0,
  );
});

test("after signing back in the loads board reloads", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.locator(".loadCard").first()).toBeVisible();
  await expireSession(page);
  await page.getByRole("button", { name: "Refresh loads" }).click();
  const overlay = page.getByRole("dialog", { name: "Session expired" });
  await expect(overlay).toBeVisible();
  // Loaded business data does not outlive the session.
  await expect(page.locator(".loadCard")).toHaveCount(0);
  await overlay
    .getByLabel("Email", { exact: true })
    .fill("dispatcher@relay.test");
  await overlay
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await overlay.getByRole("button", { name: /^Sign in/ }).click();
  await expect(overlay).toHaveCount(0);
  await expect(page.locator(".loadCard").first()).toBeVisible();
});
