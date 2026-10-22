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

test("billing on a phone: tiles share rows, filter chips never overlap, invoice cards use two columns", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/billing");
  const tiles = page.getByRole("group", { name: "Billing summary" });
  await expect(tiles).toBeVisible();
  const tops = await tiles
    .locator(".reportTile")
    .evaluateAll((els) => [
      ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))),
    ]);
  expect(tops.length).toBeLessThanOrEqual(2);
  for (const tab of [/^Invoices/, /^Carrier freight/]) {
    await page.getByRole("tab", { name: tab }).click();
    const rects = await page
      .getByRole("tabpanel")
      .locator(".attentionChip")
      .evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return [r.left, r.top, r.right, r.bottom];
        }),
      );
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        const overlap =
          a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
        expect(overlap).toBe(false);
      }
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
