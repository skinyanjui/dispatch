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

test("by carrier: a table with sortable headers on a desktop, cards with a sort select on a phone", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/reports");
  const region = page.getByRole("region", { name: "By carrier" });
  await expect(region.getByRole("columnheader", { name: /^Loads/ })).toBeVisible();
  await expect(page.getByLabel("Sort carriers by")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/reports");
  await expect(region).toBeVisible();
  // The header row is clipped to nothing on phones (kept for screen readers).
  const head = (await region.locator("thead").first().boundingBox())!;
  expect(head.width).toBeLessThanOrEqual(2);
  const sort = page.getByLabel("Sort carriers by");
  await expect(sort).toBeVisible();
  // Each carrier is a card whose figures carry their labels.
  const card = region.getByRole("row").nth(1);
  for (const label of ["Loads", "Freight", "Open exceptions"]) {
    const cell = card.locator(`td[data-label="${label}"]`);
    await expect(cell).toHaveCount(1);
    expect(
      await cell.evaluate((el) => getComputedStyle(el, "::before").content),
    ).toContain(label);
  }
  await sort.selectOption("freight");
  await expect(sort).toHaveValue("freight");
  const rows = region.getByRole("row");
  const inside = await rows.evaluateAll((els) =>
    els.slice(1).every((r) => r.getBoundingClientRect().right <= 391),
  );
  expect(inside).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
