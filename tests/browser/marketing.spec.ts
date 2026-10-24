import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

async function scan(page: Page, name: string) {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const r = await (
      window as unknown as {
        axe: {
          run: (
            c: Document,
            o: object,
          ) => Promise<{ violations: { id: string; nodes: unknown[] }[] }>;
        };
      }
    ).axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
    });
    return r.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  });
  expect(violations, name).toEqual([]);
}
const pages: [string, string][] = [
  ["/welcome", "Everything in motion. All in one place."],
  ["/how-it-works", "From rate confirmation to dispatch invoice"],
  ["/get-started", "From request to first load"],
  ["/pricing", "Free during early access"],
];

test("public pages render, are accessible, fit phones and link to real destinations", async ({
  page,
}) => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: heading, level: 1 }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await scan(page, path + " " + size.width);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/welcome");
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Request access" })
      .first(),
  ).toHaveAttribute("href", "/request-access");
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toHaveAttribute("href", "/");
  // No invented customers, prices or live claims. The labelled drawing of the
  // workspace (made-up sample values) is excluded from this check.
  const copy = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(".preview, script, style")
      .forEach((e) => e.remove());
    return clone.innerText ?? clone.textContent ?? "";
  });
  expect(copy).not.toMatch(/\$\d|testimonial|trusted by/i);
  await expect(page.locator(".previewNote")).toContainText("not live data");
  await expect(page.getByRole("main")).toContainText("fictional sample data");
  // The top bar stays put while the page scrolls.
  await page.mouse.wheel(0, 1500);
  await expect(page.locator(".mkBar")).toBeInViewport({ ratio: 1 });
  expect((await page.locator(".mkBar").boundingBox())!.y).toBeLessThan(2);
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/get-started$/);
  await page.getByRole("link", { name: "Pricing" }).first().click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByText("monthly limit")).toBeVisible();
});

test("tabs and header links share one row on a phone instead of stranding one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/welcome");
  const rows = (sel: string) =>
    page
      .locator(sel)
      .evaluateAll(
        (els) =>
          new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))
            .size,
      );
  expect(await rows(".previewTabs button")).toBe(1);
  expect(await rows(".mkHeader nav a")).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("marketing on a phone: the footer lines up with the brand and the product preview fits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/welcome");
  const brand = await page.locator(".mkFooter .brand").boundingBox();
  const link = await page.locator(".mkFooter nav a").first().boundingBox();
  expect(Math.abs(brand!.x - link!.x)).toBeLessThan(2);
  // The drawing is the real screens in a window: nothing overflows the page.
  for (const tab of ["Board", "Table", "Calendar", "Documents"]) {
    await page.getByRole("tab", { name: tab }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/pricing");
  // The plan card holds its price, button and every included item.
  const plan = (await page.locator(".pricingCard").boundingBox())!;
  const items = page.locator(".pricingCard .pricingIncludes li");
  expect(await items.count()).toBe(6);
  for (const box of await items.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, right: r.right };
    }),
  )) {
    expect(box.x).toBeGreaterThanOrEqual(plan.x);
    expect(box.right).toBeLessThanOrEqual(plan.x + plan.width);
  }
  await expect(
    page.locator(".pricingCard").getByRole("link", { name: "Request access" }),
  ).toBeVisible();
});

test("sign-in and request-access heroes use the same short line as the product page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ["/", "/request-access"]) {
    await page.goto(path);
    await expect(
      page.getByText(
        "Book freight, record every step and bill separately for your carriers",
      ),
    ).toBeVisible();
  }
});
