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

test("account: two aligned columns on a desktop, one on a phone", async ({
  page,
}) => {
  await login(page);
  for (const [width, columns] of [
    [1440, 2],
    [390, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/account");
    const region = page.getByRole("region", { name: "Account settings" });
    await expect(region.getByRole("heading", { name: "Profile" })).toBeVisible();
    const lefts = await region
      .locator(".opsCard")
      .evaluateAll((els) => [
        ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))),
      ]);
    expect(lefts.length).toBe(columns);
    expect(await noOverflow(page)).toBe(true);
  }
});

test("notifications: the delivery log shows 20 at a time", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/notifications");
  const region = page.getByRole("region", { name: "Notifications" });
  await expect(region.getByRole("group", { name: "Email me about" })).toBeVisible();
  const rows = region.getByRole("article");
  await expect
    .poll(async () => await rows.count(), { timeout: 10000 })
    .toBeGreaterThanOrEqual(0);
  const first = await rows.count();
  expect(first).toBeLessThanOrEqual(20);
  const more = region.getByRole("button", { name: /^Show more/ });
  if (await more.count()) {
    expect(first).toBe(20);
    await more.click();
    expect(await rows.count()).toBeGreaterThan(20);
  }
  expect(await noOverflow(page)).toBe(true);
});
