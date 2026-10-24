import { test, expect } from "@playwright/test";

/**
 * The inner public pages say each thing once. The header already carries
 * Request access and the page name, so a page does not repeat either in an
 * eyebrow, a closing banner or a second copy of the same promise.
 */
const pages = [
  ["/how-it-works", "From rate confirmation to dispatch invoice"],
  ["/get-started", "From request to first load"],
  ["/pricing", "Free during early access"],
] as const;

for (const [path, title] of pages)
  test(`${path} has one heading for the page and no closing banner`, async ({
    page,
  }) => {
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.locator(".mkCta")).toHaveCount(0);
    // The page name is in the header and the breadcrumb; no third copy above the title.
    await expect(page.locator(".mkHero .mkEyebrow")).toHaveCount(0);
    const headings = await main.getByRole("heading").allInnerTexts();
    expect(new Set(headings).size).toBe(headings.length);
  });

test("how it works links to the demo once, in its opening line", async ({
  page,
}) => {
  await page.goto("/how-it-works");
  await expect(
    page.getByRole("main").getByRole("link", { name: /interactive demo/i }),
  ).toHaveCount(1);
});

test("get started has one way to start: the first step", async ({ page }) => {
  await page.goto("/get-started");
  await expect(
    page.getByRole("main").getByRole("link", { name: /request/i }),
  ).toHaveCount(1);
});

test("pricing states each promise once", async ({ page }) => {
  await page.goto("/pricing");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Request access" })).toHaveCount(
    1,
  );
  const text = await main.innerText();
  const times = (re: RegExp) => (text.match(re) ?? []).length;
  expect(times(/payment details/gi)).toBe(1);
  expect(times(/before any charge/gi)).toBe(1);
  // The limit is said when AI is switched on (see mini-demos.spec.ts), not twice.
  expect(times(/monthly limit/gi)).toBeLessThanOrEqual(1);
  expect(times(/off (by default|until)/gi)).toBeLessThanOrEqual(2);
  await expect(main.locator("details")).toHaveCount(0);
});

for (const path of ["/terms", "/privacy"])
  test(`${path} does not repeat the header's sign-in link at its end`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("link", { name: /back to sign in/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Sign in", exact: true }),
    ).toHaveCount(1);
  });
