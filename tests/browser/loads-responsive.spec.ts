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
  // The attention counts wrap when a row is full, and never overlap.
  const chips = await page
    .getByRole("group", { name: "Show only" })
    .getByRole("button")
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      }),
    );
  for (let i = 0; i < chips.length; i++) {
    expect(chips[i][2]).toBeLessThanOrEqual(391);
    for (let j = i + 1; j < chips.length; j++) {
      const [a, b] = [chips[i], chips[j]];
      expect(
        a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1,
      ).toBe(false);
    }
  }
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

test("load cards are compact: reference and amount share a line, facts stay inside the card", async ({
  page,
}) => {
  await login(page);
  for (const [width, maxHeight] of [
    [1440, 200],
    [390, 220],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const card = page.locator(".lane.booked .loadCard").first();
    await expect(card).toBeVisible();
    const head = card.locator(".lcHead");
    const ref = (await head.locator(".lcRef").boundingBox())!;
    const amount = (await head.locator(".lcAmount").boundingBox())!;
    expect(Math.abs(ref.y - amount.y)).toBeLessThan(6);
    const box = (await card.boundingBox())!;
    expect(box.height).toBeLessThan(maxHeight);
    const outside = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [...el.querySelectorAll(".lcFact, .lcRoute, .lcStep")].filter(
        (c) => c.getBoundingClientRect().right > r.right + 1,
      ).length;
    });
    expect(outside).toBe(0);
    // The next step stays on the card for the unit tests that read it.
    await expect(card.locator(".cardStep")).toBeVisible();
  }
});
