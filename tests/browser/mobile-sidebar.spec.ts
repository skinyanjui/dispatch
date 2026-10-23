import { test, expect } from "@playwright/test";

/**
 * The phone navigation sheet is opaque (the page must not show through it),
 * and light text stays dark enough to read: --muted and --subtle meet 6:1 on
 * the white panel in the app, so they are never a pale grey again.
 */
test("the phone navigation sheet is opaque", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.locator(".navigationSheet");
  await expect(sheet).toBeVisible();
  const alpha = await sheet.evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)!;
    return m.length > 3 ? Number(m[3]) : 1;
  });
  expect(alpha).toBe(1);
  // Opaque and drawn above the page: the point under the sheet is the sheet.
  const top = await page.evaluate(() => {
    const at = document.elementFromPoint(100, 400);
    return !!at?.closest(".navigationSheet");
  });
  expect(top).toBe(true);
});

test("light text meets 6:1 on the panel", async ({ page }) => {
  await page.goto("/demo");
  const ratios = await page.evaluate(() => {
    const root = document.querySelector(".appShell") ?? document.body;
    const css = getComputedStyle(root);
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const rgb = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe)
        .color.match(/\d+/g)!
        .slice(0, 3)
        .map(Number);
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const panel = lum(rgb(css.getPropertyValue("--panel")));
    const out: Record<string, number> = {};
    for (const t of ["--muted", "--subtle"]) {
      const l = lum(rgb(css.getPropertyValue(t)));
      out[t] = (panel + 0.05) / (l + 0.05);
    }
    probe.remove();
    return out;
  });
  expect(ratios["--muted"]).toBeGreaterThanOrEqual(6);
  expect(ratios["--subtle"]).toBeGreaterThanOrEqual(6);
});
