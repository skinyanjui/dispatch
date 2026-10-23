import { test, expect, type Page } from "@playwright/test";

// Shared controls (src/components/ui, ADR 0051): choosing a tab, chip,
// segment, folder or queue never moves the controls beside it or the strip
// they sit in.
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

const groups =
  '[role="tablist"], [role="group"]:has(> button[aria-pressed]), nav[aria-label="Dispatch queues"]';
const items = '[role="tab"], button[aria-pressed], .queueTab';

/** Click each control in each strip on the page and compare positions. */
async function expectSteady(page: Page, where: string) {
  const strips = page.locator(`.workspace :is(${groups})`);
  const count = await strips.count();
  for (let g = 0; g < count; g++) {
    const strip = strips.nth(g);
    if (!(await strip.isVisible())) continue;
    const controls = strip.locator(`:scope > :is(${items})`);
    const n = await controls.count();
    for (let i = 0; i < n; i++) {
      const target = controls.nth(i);
      if (!(await target.isVisible()) || (await target.isDisabled())) continue;
      const boxes = () =>
        strip.evaluate((el, sel) => {
          // Positions inside the strip, so a strip that scrolls a tapped
          // item into view (a phone chip row) does not count as movement.
          const s = el.getBoundingClientRect();
          return [
            // The strip may scroll sideways in its container or grow with
            // its neighbours; it must not move up or down or change height.
            [s.y, s.height].map(Math.round),
            ...[...el.querySelectorAll(`:scope > :is(${sel})`)].map((c) => {
              const r = c.getBoundingClientRect();
              return [
                r.x - s.x + el.scrollLeft,
                r.y - s.y + el.scrollTop,
                r.width,
                r.height,
              ].map(Math.round);
            }),
          ];
        }, items);
      const before = await boxes();
      await target.click();
      await page.waitForTimeout(250);
      if (!(await strip.isVisible())) return;
      const after = await boxes();
      if (after.length !== before.length) continue; // items depend on data
      const label = (await target.innerText()).replace(/\s+/g, " ");
      expect(after, `${where}: "${label}" moved its strip`).toEqual(before);
    }
  }
}

for (const width of [1440, 390]) {
  test(`choosing tabs, chips and segments moves nothing at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/account",
      "/organization",
      "/documents",
      "/billing",
      "/reports",
      "/prospects",
      "/inbox",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expectSteady(page, path);
    }
  });
}
