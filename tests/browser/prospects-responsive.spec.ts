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

test("prospects on a desktop: all six stages fit without sideways scrolling", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/prospects");
  const board = page.getByRole("region", { name: "Prospect board" });
  await expect(board).toBeVisible();
  const lanes = board.getByRole("region");
  await expect(lanes).toHaveCount(6);
  const last = (await lanes.nth(5).boundingBox())!;
  const frame = (await board.boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  expect(
    await board.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  expect(await noOverflow(page)).toBe(true);
});

test("prospects on a phone: one stage at a time with the next peeking in", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/prospects");
  const board = page.getByRole("region", { name: "Prospect board" });
  const lanes = board.getByRole("region");
  const first = (await lanes.nth(0).boundingBox())!;
  const second = (await lanes.nth(1).boundingBox())!;
  expect(first.width).toBeGreaterThan(220);
  expect(second.x).toBeLessThan(390);
  expect(await noOverflow(page)).toBe(true);
});
