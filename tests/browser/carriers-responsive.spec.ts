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

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["phone", 390, 844],
] as const) {
  test(`carriers on a ${name}: filter tiles fill the row, sort stays reachable, nothing overflows`, async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize({ width, height });
    await page.goto("/carriers");
    const tiles = page.getByRole("group", { name: "Filter carriers" });
    await expect(tiles.getByRole("button").first()).toBeVisible();
    const boxes = await tiles
      .getByRole("button")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    const group = (await tiles.boundingBox())!;
    const rows = new Set(boxes.map((b) => Math.round(b.top)));
    // Four tiles: one row on a desktop, two on a phone, and each row is full.
    expect(rows.size).toBe(width > 700 ? 1 : 2);
    for (const row of rows) {
      const inRow = boxes.filter((b) => Math.round(b.top) === row);
      const right = Math.max(...inRow.map((b) => b.right));
      expect(Math.abs(right - (group.x + group.width))).toBeLessThan(2);
    }
    await expect(page.getByLabel("Sort carriers")).toBeVisible();
    // The signed-in person's own role is not repeated on every row.
    await expect(page.locator(".roleLabel", { hasText: "Dispatcher" })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
