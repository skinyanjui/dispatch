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
  test(`contacts on a ${name}: every action stays inside its row and nothing overflows`, async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize({ width, height });
    await page.goto("/contacts");
    const rows = page.getByRole("article");
    await expect(rows.first()).toBeVisible();
    const outside = await rows.evaluateAll((els) =>
      els.slice(0, 20).flatMap((row) => {
        const box = row.getBoundingClientRect();
        return [...row.querySelectorAll("a, button")]
          .filter((c) => {
            const r = c.getBoundingClientRect();
            return r.right > box.right + 1 || r.left < box.left - 1;
          })
          .map((c) => c.getAttribute("aria-label") || c.textContent);
      }),
    );
    expect(outside).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // A long list of carriers collapses to the first and a count.
    const long = rows.filter({ hasText: "more" }).first();
    if (await long.count())
      await expect(long.locator(".dirMain small").first()).toContainText(
        /\+\d+ more/,
      );
  });
}
