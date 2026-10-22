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
  const tiles = page.locator(".reportTiles").first().locator(".reportTile");
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
  const groups = page.locator(".reports .reportTiles");
  const count = await groups.count();
  for (let i = 0; i < count; i++) {
    const g = groups.nth(i);
    const frame = (await g.boundingBox())!;
    const boxes = await g
      .locator(".reportTile")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    const top = Math.min(...boxes.map((b) => b.top));
    const firstRow = boxes.filter((b) => Math.abs(b.top - top) < 2);
    const right = Math.max(...firstRow.map((b) => b.right));
    expect(Math.abs(right - (frame.x + frame.width))).toBeLessThan(2);
  }
  expect(await noOverflow(page)).toBe(true);
});
