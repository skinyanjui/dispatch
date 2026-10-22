import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(response.status()).toBe(200);
}
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("loads on a phone: toolbar rows fill, counts share a row, board peeks the next stage", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const layout = page.getByRole("group", { name: "Layout" });
  await expect(layout).toBeVisible();
  // The layout switch spans the row; its three options sit side by side.
  const box = (await layout.boundingBox())!;
  expect(box.width).toBeGreaterThan(300);
  const attention = page.getByRole("group", { name: "Show only" });
  const tops = await attention
    .getByRole("button")
    .evaluateAll((els) => [
      ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))),
    ]);
  expect(tops.length).toBe(1);
  // Stages scroll sideways with the next one in view.
  const lanes = page.locator(".lane");
  expect(await lanes.count()).toBeGreaterThan(1);
  const second = (await lanes.nth(1).boundingBox())!;
  expect(second.x).toBeLessThan(390);
  expect(await noOverflow(page)).toBe(true);
});

test("loads on a phone: the calendar is a list of days, the table keeps its first column", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Calendar" })
    .click();
  const calendar = page.getByRole("region", { name: "Load calendar" });
  await expect(calendar.getByRole("grid")).toBeHidden();
  const agenda = calendar.locator(".calendarAgenda");
  await expect(agenda).toBeVisible();
  // A day with loads lists them; one opens the load.
  const item = agenda.getByRole("button").first();
  if (await item.count()) {
    await item.click();
    await expect(
      page.getByRole("dialog", { name: "Load details" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  } else {
    await expect(agenda).toContainText("No loads this month");
  }
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Table" })
    .click();
  const first = page.locator(".loadTable tbody th").first();
  await expect(first).toBeVisible();
  expect(
    await first.evaluate((el) => getComputedStyle(el).position),
  ).toBe("sticky");
  expect(await noOverflow(page)).toBe(true);
});

test("loads on a desktop keep the calendar grid", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Calendar" })
    .click();
  const calendar = page.getByRole("region", { name: "Load calendar" });
  await expect(calendar.getByRole("grid")).toBeVisible();
  await expect(calendar.locator(".calendarAgenda")).toBeHidden();
});
