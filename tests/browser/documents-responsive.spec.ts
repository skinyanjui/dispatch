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

test("documents: the page opens on a list that has something in it", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/documents");
  const chips = page.getByRole("group", { name: "Show drafts" });
  await expect(chips).toBeVisible();
  const total = Number(
    await chips.getByRole("button", { name: /^All/ }).locator(".toggleCount").innerText(),
  );
  const needs = Number(
    await chips
      .getByRole("button", { name: /^Needs review/ })
      .locator(".toggleCount")
      .innerText(),
  );
  const pressed = chips.locator('[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  // "Needs review" is the default only when something needs review.
  if (total > 0 && needs === 0) await expect(pressed).toContainText("All");
  if (needs > 0) await expect(pressed).toContainText("Needs review");
});

test("documents on a phone: chips and cards fit, template actions stay inside their row", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/documents");
  const rects = await page
    .getByRole("group", { name: "Show drafts" })
    .locator(".chip")
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      }),
    );
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      expect(
        a[0] < b[2] - 1 &&
          b[0] < a[2] - 1 &&
          a[1] < b[3] - 1 &&
          b[1] < a[3] - 1,
      ).toBe(false);
    }
  expect(await noOverflow(page)).toBe(true);
  await page.getByRole("tab", { name: /^Templates/ }).click();
  const list = page.getByRole("list", { name: "Templates" });
  if (await list.count()) {
    const outside = await list.locator("li").evaluateAll((rows) =>
      rows.slice(0, 10).flatMap((row) => {
        const box = row.getBoundingClientRect();
        return [...row.querySelectorAll("button")]
          .filter((b) => b.getBoundingClientRect().right > box.right + 1)
          .map((b) => b.textContent);
      }),
    );
    expect(outside).toEqual([]);
  }
  expect(await noOverflow(page)).toBe(true);
});
