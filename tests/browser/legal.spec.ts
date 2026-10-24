import { test, expect } from "@playwright/test";

for (const [path, title] of [
  ["/terms", "Terms of use"],
  ["/privacy", "Privacy"],
] as const) {
  test(`${path}: site header, breadcrumb, working "On this page" links`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    // The same top bar and footer as the rest of the site.
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", {
        name: "Pricing",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toContainText(title);
    // Every contents link points at a heading that exists.
    const toc = page.getByRole("navigation", { name: "On this page" });
    const links = toc.getByRole("link");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < count; i++) {
      const href = (await links.nth(i).getAttribute("href"))!;
      expect(href.startsWith("#")).toBe(true);
      await expect(page.locator(href)).toHaveCount(1);
    }
    // Following one lands on its heading, below the sticky bar.
    await links.last().click();
    const target = page.locator((await links.last().getAttribute("href"))!);
    await expect(target).toBeInViewport();
    expect((await target.boundingBox())!.y).toBeGreaterThan(50);
    // The reading column is not wider than about 70 characters.
    const doc = (await page.locator(".legalDoc").boundingBox())!;
    expect(doc.width).toBeLessThan(760);
  });

  test(`${path} on a phone: contents wrap as links, nothing overflows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    const toc = page.getByRole("navigation", { name: "On this page" });
    await expect(toc).toBeVisible();
    const box = (await toc.boundingBox())!;
    expect(box.height).toBeLessThan(300); // links are 40px tall touch targets
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole("note")).toContainText(
      "not reviewed by a lawyer",
    );
  });
}
