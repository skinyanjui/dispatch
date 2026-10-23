import { test, expect } from "@playwright/test";

/**
 * One layout for every page (ADR 0053): the first block sits at the workspace
 * padding, blocks are one --page-gap apart, and blocks carry no outer margin
 * that would stack on the gap. Runs on the demo, which needs no database.
 */
const pages = [
  "Exceptions",
  "Contacts",
  "Carriers",
  "Fleet",
  "Prospects",
  "Documents",
  "Billing",
  "Reports",
];

for (const width of [1280, 390]) {
  test(`every page stacks its blocks on one gap and offset at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/demo");
    const nav = page.getByRole("navigation", { name: "Workspace navigation" });
    for (const name of pages) {
      if (width < 800)
        await page
          .getByRole("button", { name: /navigation|menu/i })
          .first()
          .click()
          .catch(() => {});
      await nav.getByRole("button", { name, exact: true }).click();
      const m = await page.evaluate(() => {
        const ws = document.querySelector(".workspace")!;
        const root = ws.querySelector(
          ".carrierDirectory, .excPage, .fleetPage, .orgPage, .reports",
        )!;
        const gap = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--space-3",
          ),
        );
        const blocks = [...root.children].filter(
          (c) =>
            c.getBoundingClientRect().height > 0 &&
            getComputedStyle(c).position !== "absolute" &&
            !c.classList.contains("directoryNote"),
        );
        const tops = blocks.map((b) => b.getBoundingClientRect());
        const rs = getComputedStyle(root);
        return {
          gap,
          rowGap: parseFloat(rs.rowGap),
          paddingTop: parseFloat(rs.paddingTop),
          offset:
            tops[0].top -
            ws.getBoundingClientRect().top -
            parseFloat(getComputedStyle(ws).paddingTop),
          gaps: tops.slice(1).map((r, i) => Math.round(r.top - tops[i].bottom)),
          margins: blocks
            .filter((b) => !/^H[23]$/.test(b.tagName))
            .map((b) => {
              const s = getComputedStyle(b);
              return parseFloat(s.marginTop) + parseFloat(s.marginBottom);
            }),
        };
      });
      expect(m.rowGap, `${name} gap`).toBe(m.gap);
      expect(m.paddingTop, `${name} root padding`).toBe(0);
      expect(Math.round(m.offset), `${name} top offset`).toBe(0);
      expect(
        m.margins.every((x) => x === 0),
        `${name} block margins`,
      ).toBe(true);
      for (const g of m.gaps) {
        // Section headings add one step above themselves.
        expect([m.gap, m.gap * 2], `${name} gaps ${m.gaps}`).toContain(g);
      }
    }
  });
}

const allPages = [
  "Loads",
  "Exceptions",
  "Inbox",
  "Contacts",
  "Carriers",
  "Fleet",
  "Prospects",
  "Assistant",
  "Documents",
  "Billing",
  "Reports",
];

test("all eleven pages fill the same width on a wide screen", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto("/demo");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const name of allPages) {
    await nav.getByRole("button", { name, exact: true }).click();
    // The widest block fills the workspace, and no block is narrower than the
    // page's other blocks by more than its own layout (all are full width).
    const m = await page.evaluate(() => {
      const ws = document.querySelector(".workspace")!;
      const s = getComputedStyle(ws);
      const available =
        ws.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      const widths = [...ws.children]
        .filter(
          (c) =>
            c.tagName !== "FOOTER" &&
            c.getBoundingClientRect().height > 8 &&
            c.getBoundingClientRect().width > 8 &&
            getComputedStyle(c).position !== "fixed",
        )
        .map((c) => Math.round(c.getBoundingClientRect().width));
      return { available: Math.round(available), widths };
    });
    expect(m.available, `${name} workspace`).toBeGreaterThan(1600);
    expect(Math.max(...m.widths), `${name} widest block`).toBe(m.available);
    expect(Math.min(...m.widths), `${name} narrowest block`).toBe(m.available);
  }
});

test("no page scrolls sideways at laptop width", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/demo");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const name of allPages) {
    await nav.getByRole("button", { name, exact: true }).click();
    const over = await page.evaluate(() => {
      const ws = document.querySelector(".workspace")!;
      return ws.scrollWidth - ws.clientWidth;
    });
    expect(over, `${name} overflows the page`).toBeLessThanOrEqual(1);
  }
});
