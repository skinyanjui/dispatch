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
