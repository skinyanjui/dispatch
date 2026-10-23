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

test("reports on a phone: every date option is reachable, tiles sit two across, nothing overflows", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/reports");
  const range = page.getByRole("group", { name: "Date range" });
  await expect(range).toBeVisible();
  // Every option, including Custom, is inside the screen.
  const rects = await range
    .getByRole("button")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  expect(rects.length).toBeGreaterThanOrEqual(4);
  for (const r of rects) {
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(390);
  }
  const tiles = page.locator(".stats").first().locator(".stat");
  await expect(tiles.first()).toBeVisible();
  const lefts = await tiles.evaluateAll((els) => [
    ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))),
  ]);
  expect(lefts.length).toBe(2);
  expect(await noOverflow(page)).toBe(true);
});

test("reports on a desktop: tiles of every group fill their row", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  const groups = page.locator(".reports .stats");
  const count = await groups.count();
  for (let i = 0; i < count; i++) {
    const g = groups.nth(i);
    const frame = (await g.boundingBox())!;
    const boxes = await g
      .locator(".stat")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    const top = Math.min(...boxes.map((b) => b.top));
    const firstRow = boxes.filter((b) => Math.abs(b.top - top) < 2);
    const right = Math.max(...firstRow.map((b) => b.right));
    expect(Math.abs(right - (frame.x + frame.width))).toBeLessThan(2);
  }
  expect(await noOverflow(page)).toBe(true);
});

test("by carrier: one table with shared, sortable headers on every screen", async ({
  page,
}) => {
  await login(page);
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/reports");
    const region = page.getByRole("region", { name: "By carrier" });
    const loads = region.getByRole("columnheader", { name: /^Loads/ });
    // Headers are shown once, on phones too; cells never repeat them.
    await expect(loads).toBeVisible();
    await expect(region.locator("[data-label]")).toHaveCount(0);
    await expect(loads).toHaveAttribute("aria-sort", "descending");
    const freight = region.getByRole("columnheader", { name: /^Freight/ });
    await freight.getByRole("button").click();
    await expect(freight).toHaveAttribute("aria-sort", "descending");
    // Money lines up on the right, under its header.
    expect(
      await region
        .locator("tbody td")
        .nth(3)
        .evaluate((el) => getComputedStyle(el).textAlign),
    ).toBe("right");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
