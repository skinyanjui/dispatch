import { test, expect } from "@playwright/test";

/**
 * Tiles in a row line up (StatTile): the figure and the detail start at the
 * same height in every tile, and an action link is pinned to the bottom edge,
 * so it sits at the same height whatever text is above it. Runs on the demo
 * Reports page, which mixes tiles with and without a change line and a link.
 */
for (const width of [1920, 1280, 390]) {
  test(`report tiles share figure, detail and action positions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/demo");
    if (width < 800) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .locator(".navigationSheet")
        .getByText("Reports", { exact: true })
        .click();
    } else {
      await page
        .getByRole("navigation", { name: "Workspace navigation" })
        .getByRole("button", { name: "Reports", exact: true })
        .click();
    }
    await expect(page.locator(".statAction").first()).toBeVisible();
    // Tiles that share a visual row (a group wraps on phones).
    const rows = await page.evaluate(() => {
      const byRow: Record<string, Array<Record<string, number | null>>> = {};
      document.querySelectorAll(".stats").forEach((group, g) => {
        for (const tile of group.children) {
          const t = tile.getBoundingClientRect();
          const rel = (sel: string, edge: "top" | "bottom") => {
            const el = tile.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return Math.round(
              edge === "top" ? r.top - t.top : t.bottom - r.bottom,
            );
          };
          (byRow[g + ":" + Math.round(t.top)] ??= []).push({
            height: Math.round(t.height),
            value: rel("strong", "top"),
            detail: rel(".statDetail", "top"),
            action: rel(".statAction", "bottom"),
          });
        }
      });
      return Object.values(byRow);
    });
    for (const tiles of rows) {
      const same = (key: "height" | "value" | "detail" | "action") => {
        const seen = new Set(
          tiles.map((x) => x[key]).filter((v) => v !== null),
        );
        expect(seen.size, `${key}: ${[...seen]}`).toBeLessThanOrEqual(1);
      };
      same("height");
      same("value");
      same("detail");
      same("action");
    }
    // At least one row has several links over unlike content: the real case.
    expect(
      rows.some((r) => r.filter((x) => x.action !== null).length > 1),
    ).toBe(true);
  });
}

test("no report tile label wraps at 1440px, so no tile gets a gap above its figure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo");
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Reports", exact: true })
    .click();
  await expect(page.locator(".statAction").first()).toBeVisible();
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll(".stat .statLabel")].map((el) => ({
      text: el.textContent,
      lines: Math.round(
        el.getBoundingClientRect().height /
          parseFloat(getComputedStyle(el).lineHeight),
      ),
    })),
  );
  expect(labels.length).toBeGreaterThan(5);
  for (const l of labels) expect(l.lines, l.text ?? "").toBe(1);
});
