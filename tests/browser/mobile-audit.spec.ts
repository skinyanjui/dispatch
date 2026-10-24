import { test, expect, type Page } from "@playwright/test";

/**
 * Phone audit (src/app/mobile.css). On every page, at the smallest and a common
 * phone width: nothing makes the page scroll sideways, text is at least 11px,
 * form controls are 16px (iOS zooms the page on focus below that), and buttons,
 * links and fields are at least 36px tall (the layer sets 40px; 36 leaves room
 * for rounding). Inline links inside text are exempt, as in WCAG 2.2.
 */
const publicPages = [
  "/welcome",
  "/how-it-works",
  "/get-started",
  "/pricing",
  "/terms",
  "/privacy",
  "/request-access",
  "/",
  "/demo",
];
const appPages = [
  "/",
  "/exceptions",
  "/inbox",
  "/contacts",
  "/carriers",
  "/fleet",
  "/prospects",
  "/assistant",
  "/documents",
  "/billing",
  "/reports",
  "/account",
  "/organization",
  "/audit",
  "/notifications",
];

async function problems(page: Page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const scrolls = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (
          /(auto|scroll|hidden|clip)/.test(s.overflowX) &&
          p !== document.documentElement &&
          p !== document.body
        )
          return true;
      }
      return false;
    };
    const shown = (el: Element) => {
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return (
        s.visibility !== "hidden" &&
        s.display !== "none" &&
        r.width > 0 &&
        r.height > 0 &&
        !el.closest("[inert],[hidden],[aria-hidden=true]")
      );
    };
    const out: string[] = [];
    const doc = document.documentElement.scrollWidth - vw;
    if (doc > 0) out.push(`page scrolls sideways by ${doc}px`);
    for (const el of document.querySelectorAll("body *")) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el),
        name = `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`;
      if (
        (r.right > vw + 1 || r.left < -1) &&
        !scrolls(el) &&
        s.position !== "fixed" &&
        !el.classList.contains("mkSkip")
      )
        out.push(
          `${name} outside the screen (${Math.round(r.left)}..${Math.round(r.right)})`,
        );
      if (
        el.children.length === 0 &&
        (el.textContent ?? "").trim() &&
        parseFloat(s.fontSize) < 11
      )
        out.push(`${name} text is ${s.fontSize}`);
      const tag = el.tagName;
      if (
        /^(INPUT|SELECT|TEXTAREA)$/.test(tag) &&
        !/(checkbox|radio|hidden|file|range|color)/.test(
          (el as HTMLInputElement).type,
        ) &&
        parseFloat(s.fontSize) < 16
      )
        out.push(`${name} is ${s.fontSize}, so iOS would zoom on focus`);
      const control =
        /^(A|BUTTON|SUMMARY|SELECT|INPUT|TEXTAREA)$/.test(tag) ||
        el.getAttribute("role") === "tab";
      if (!control || el.classList.contains("mkSkip")) continue;
      if (
        tag === "INPUT" &&
        /(checkbox|radio|hidden)/.test((el as HTMLInputElement).type)
      )
        continue;
      if (
        tag === "A" &&
        s.display === "inline" &&
        el.closest("p, li, small, td, span")
      )
        continue;
      if ((r.height < 36 && !scrolls(el)) || r.width < 24)
        out.push(
          `${name} "${(el.textContent ?? "").trim().slice(0, 20)}" is ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return [...new Set(out)].slice(0, 8);
  });
}
const login = async (page: Page, email: string) => {
  const r = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(r.status()).toBe(200);
};

for (const width of [320, 390]) {
  test(`public pages fit a ${width}px phone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const path of publicPages) {
      await page.goto(path);
      await page.waitForTimeout(600);
      expect(await problems(page), `${path} at ${width}px`).toEqual([]);
    }
  });
  for (const [email, label, paths] of [
    ["dispatcher@relay.test", "dispatcher", appPages],
    [
      "driver@relay.test",
      "driver",
      ["/", "/exceptions", "/inbox", "/contacts", "/account"],
    ],
  ] as const)
    test(`the ${label}'s pages fit a ${width}px phone`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await login(page, email);
      for (const path of paths) {
        await page.goto(path);
        await page.waitForTimeout(900);
        expect(await problems(page), `${path} at ${width}px`).toEqual([]);
      }
    });
}

test("a table wider than the screen fades the edge that scrolls, and says so when it ends", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page, "dispatcher@relay.test");
  await page.goto("/fleet");
  const table = page.locator(".dataTable").first();
  await expect(table).toHaveAttribute("data-more", "end");
  await table.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect(table).toHaveAttribute("data-more", "start");
});

test("a long button label wraps inside the new-load form", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page, "dispatcher@relay.test");
  await page.goto("/");
  await page.getByRole("button", { name: "New load" }).first().click();
  const sheet = page.locator(".overlay").first();
  await expect(sheet).toBeVisible();
  const outside = await sheet.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll("button")].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.right > box.right + 1;
    }).length;
  });
  expect(outside).toBe(0);
});
