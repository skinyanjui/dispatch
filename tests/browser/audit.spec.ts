import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(response.status()).toBe(200);
}
const path = (page: Page) => new URL(page.url()).pathname;
async function scan(page: Page) {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const r = await (
      window as unknown as {
        axe: {
          run: (
            c: Document,
            o: object,
          ) => Promise<{ violations: { id: string; nodes: unknown[] }[] }>;
        };
      }
    ).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return r.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  });
  expect(violations).toEqual([]);
}

test("an organization admin opens the audit log from the account menu and filters it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Audit log" }).click();
  expect(path(page)).toBe("/audit");
  await expect(page).toHaveTitle("Audit log · Relay");
  const table = page.getByRole("table", { name: "Audit log, newest first" });
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThanOrEqual(50);
  // Every row names a person (or the system), an action and, mostly, a record.
  await expect(rows.first().locator("time")).toBeVisible();
  // Paging.
  const more = page.getByRole("button", { name: "Show more" });
  if (await more.isVisible()) {
    const before = await rows.count();
    await more.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
  // Filter by action.
  const action = page.getByLabel("Action");
  await action.selectOption({ label: "Signed in" });
  await expect
    .poll(async () =>
      (await rows.allInnerTexts()).every((t) => t.includes("Signed in")),
    )
    .toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: "entries shown" }),
  ).toBeVisible();
  // An impossible date range shows an empty state, and Clear brings it back.
  await page.getByLabel("To", { exact: true }).fill("2001-01-01");
  await expect(
    page.getByRole("heading", { name: "No entries match" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  // The sidebar search narrows the log.
  await page
    .getByRole("searchbox", { name: "Search the audit log" })
    .fill("zzz-no-such-entry");
  await expect(
    page.getByRole("heading", { name: "No entries match" }),
  ).toBeVisible();
});

test("the scheduler's state is shown beside the log", async ({ page }) => {
  await login(page);
  await page.goto("/audit");
  const panel = page.getByRole("group", { name: "Scheduler" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Every 15 minutes" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Daily sweep" }),
  ).toBeVisible();
  // State is text, not just color.
  await expect(panel.locator(".opsPill")).toHaveCount(2);
});

test("the audit page has no accessibility violations and fits a phone", async ({
  page,
}) => {
  await login(page);
  await page.goto("/audit");
  await expect(
    page.getByRole("table", { name: "Audit log, newest first" }),
  ).toBeVisible();
  await scan(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("table", { name: "Audit log, newest first" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("people who are not organization admins have no audit page", async ({
  page,
}) => {
  for (const email of ["carrier@relay.test", "driver@relay.test"]) {
    await page.context().clearCookies();
    await login(page, email);
    expect((await page.request.get("/api/audit")).status()).toBe(404);
    expect((await page.request.get("/api/audit/filters")).status()).toBe(404);
    expect((await page.request.get("/api/jobs/status")).status()).toBe(404);
    await page.goto("/audit");
    await expect(page.locator(".alert.error")).toContainText(
      /couldn.t find that/,
    );
    await expect.poll(() => path(page)).toBe("/");
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("button", { name: "Audit log" })).toHaveCount(
      0,
    );
  }
});
