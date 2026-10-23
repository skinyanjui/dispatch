import { test, expect, type Page } from "@playwright/test";

/**
 * Control sizing and alignment (ADR 0044). These check geometry, so a CSS
 * change that pushes a dropdown arrow against its border, puts neighbours on
 * different centre lines or clips a placeholder fails here.
 */
async function signIn(page: Page) {
  const login = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
}
const sections = [
  "Loads",
  "Exceptions",
  "Inbox",
  "Contacts",
  "Carriers",
  "Prospects",
  "Assistant",
  "Documents",
  "Billing",
  "Reports",
];

test("every dropdown keeps its arrow clear of the border and its text clear of the arrow", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const name of sections) {
    await nav.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(500);
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll("select")]
        .filter((s) => s.getBoundingClientRect().width > 0)
        .map((s) => {
          const c = getComputedStyle(s);
          return {
            label: s.getAttribute("aria-label") || s.name || s.id,
            appearance: c.appearance,
            padRight: parseFloat(c.paddingRight),
            pos: c.backgroundPositionX,
            height: Math.round(s.getBoundingClientRect().height),
          };
        })
        .filter(
          (s) => s.appearance !== "none" || s.padRight < 26 || s.height < 28,
        ),
    );
    expect(bad, `${name}: dropdowns without room for the arrow`).toEqual([]);
  }
});

test("controls share two heights; toolbars sit on one centre line", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const allowed = new Set([24, 28, 32]);
  for (const name of ["Loads", "Carriers", "Contacts", "Billing", "Reports"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const sel =
        "main button, main select, main input:not([type=checkbox]):not([type=radio]):not([type=hidden])";
      const heights: Record<string, string> = {};
      const centres: string[] = [];
      for (const e of document.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        const c = e as HTMLElement;
        if (
          !r.width ||
          c.closest("[aria-hidden=true],.srOnly,td,th,li,article")
        )
          continue;
        if (
          c.matches(
            ".loadCard,.stat,.carrierMetric,.threadItem,.prospectCard,.calendarEvent,.sidebarItem,.queueTab,.chip,.opsPill,.iconAction,.iconButton",
          )
        )
          continue;
        heights[
          `${e.tagName.toLowerCase()}.${String(c.className).split(" ")[0]}"${(c.innerText || c.getAttribute("aria-label") || "").trim().slice(0, 18)}"`
        ] = String(Math.round(r.height));
      }
      // Direct children of toolbar rows share a centre line.
      for (const row of document.querySelectorAll(
        ".viewBar,.viewTools,.directoryIntro,.reportBar,.opsFilters",
      )) {
        const kids = [...row.children].filter(
          (k) => k.getBoundingClientRect().height > 0,
        );
        for (let i = 1; i < kids.length; i++) {
          const a = kids[i - 1].getBoundingClientRect();
          const b = kids[i].getBoundingClientRect();
          const sameRow =
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >
            Math.min(a.height, b.height) / 2;
          const d = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
          if (sameRow && d > 2.5 && Math.max(a.height, b.height) < 50)
            centres.push(
              `${(row as HTMLElement).className}: ${Math.round(d)}px`,
            );
        }
      }
      return { heights, centres };
    });
    const off = Object.entries(result.heights).filter(
      ([, h]) => !allowed.has(Number(h)),
    );
    expect(off, `${name}: controls off the 24/28/32 scale`).toEqual([]);
    expect(result.centres, `${name}: toolbar items off centre`).toEqual([]);
  }
});

test("search placeholders fit; table headers line up with their cells; form fields share a top edge", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const name of sections) {
    await nav.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(400);
    const clipped = await page.evaluate(() => {
      const i = document.querySelector<HTMLInputElement>(
        ".sidebarSearch input",
      );
      if (!i) return "no search";
      const c = getComputedStyle(i);
      const cv = document.createElement("canvas").getContext("2d")!;
      cv.font = `${c.fontWeight} ${c.fontSize} ${c.fontFamily}`;
      const need = cv.measureText(i.placeholder).width;
      return need <= i.clientWidth
        ? ""
        : `${i.placeholder}: ${Math.round(need)} > ${i.clientWidth}`;
    });
    expect(clipped, `${name}: sidebar search placeholder`).toBe("");
  }
  // Table: the header text and the first cell's text start at the same x.
  await nav.getByRole("button", { name: "Loads", exact: true }).click();
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Table" })
    .click();
  const table = page.getByRole("region", { name: "Load table" });
  await expect(table).toBeVisible();
  const xs = await table.evaluate((t) => {
    const x = (e: Element | null) => {
      if (!e) return NaN;
      const r = document.createRange();
      r.selectNodeContents(e);
      return Math.round(r.getBoundingClientRect().left);
    };
    return [
      x(t.querySelector("thead th .sortButton")),
      x(t.querySelector("tbody th .textButton")),
    ];
  });
  expect(Math.abs(xs[0] - xs[1])).toBeLessThanOrEqual(1);
  // New load: fields in one row start at the same height.
  await page.getByRole("button", { name: "New load" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const tops = await dialog.evaluate((d) => {
    const row = d.querySelector(".formGrid")!;
    return [...row.querySelectorAll("input")].map((i) =>
      Math.round(i.closest("label")!.getBoundingClientRect().top),
    );
  });
  expect(new Set(tops).size).toBe(1);
});

test("phones: menus stay inside the screen and touch targets stay 40px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  await page.locator("details.viewOptions > summary").click();
  const box = await page.locator(".viewOptionsBody").first().boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 8);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Contacts", exact: true })
    .click();
  const icon = await page.locator(".iconAction").first().boundingBox();
  expect(icon!.height).toBeGreaterThanOrEqual(40);
});
