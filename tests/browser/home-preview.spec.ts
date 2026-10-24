import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

/**
 * The home-page drawing is the app's own screens fed by the demo's fictional
 * data, so it must agree with the app: the same pages, queues, stages and
 * cards, no load drawn twice, and nothing in it operable. These tests compare
 * it with the interactive demo, which runs the real workspace.
 */
const scan = async (page: Page) => {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  return page.evaluate(async () => {
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
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return r.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  });
};
const frame = (page: Page) => page.locator(".previewShell");
const texts = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((els) =>
      els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
    );

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the drawing lists the same pages and queues as the real workspace", async ({
  page,
}) => {
  await page.goto("/demo");
  const real = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(real.getByRole("button", { name: "Loads" })).toBeVisible();
  const realPages = await texts(
    page,
    'nav[aria-label="Workspace navigation"] .sidebarItem',
  );
  const realQueues = await texts(
    page,
    'nav[aria-label="Dispatch queues"] button',
  );
  await page.goto("/welcome");
  await expect(frame(page)).toBeVisible();
  expect(await texts(page, ".previewShell .sidebarPages .sidebarItem")).toEqual(
    realPages,
  );
  expect(await texts(page, ".previewShell .queueTabs button")).toEqual(
    realQueues,
  );
});

test("the board has the four real stages and draws every load once", async ({
  page,
}) => {
  await page.goto("/welcome");
  await expect(frame(page).locator(".loadCard").first()).toBeVisible();
  // Four lanes, named as in the app (the label is the heading's own text).
  expect(await texts(page, ".previewShell .kanban .laneHeading h2")).toEqual([
    "Booked",
    "Dispatched",
    "In transit",
    "Delivered",
  ]);
  const stages = ["Booked", "Dispatched", "In transit", "Delivered"];
  const cards = frame(page).locator(".loadCard");
  await expect(cards.first()).toBeVisible();
  const refs = await texts(page, ".previewShell .loadCard .lcRef");
  expect(refs.length).toBeGreaterThanOrEqual(4);
  expect(new Set(refs).size).toBe(refs.length);
  for (const stage of stages)
    await expect(
      frame(page).getByText(stage, { exact: true }).first(),
    ).toBeVisible();
  // What needs attention is shown, as in the app.
  await expect(
    frame(page).getByText(/loads? need(s)? attention/),
  ).toBeVisible();
  await expect(
    frame(page)
      .getByText(/missing|Needs a driver/)
      .first(),
  ).toBeVisible();
});

test("every view is a real screen: table, calendar and Documents", async ({
  page,
}) => {
  await page.goto("/welcome");
  await page.getByRole("tab", { name: "Table" }).click();
  await expect(frame(page).locator("table")).toBeVisible();
  expect(await texts(page, ".previewShell table thead th")).toEqual(
    expect.arrayContaining(["Load", "Carrier", "Stage", "Freight"]),
  );
  await page.getByRole("tab", { name: "Calendar" }).click();
  const month = new Date().toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  await expect(frame(page).getByText(month)).toBeVisible();
  await page.getByRole("tab", { name: "Documents" }).click();
  await expect(
    frame(page).getByText("Drafts", { exact: false }).first(),
  ).toBeVisible();
  await expect(frame(page).getByText("Needs review").first()).toBeVisible();
});

test("the drawing cannot be operated, is hidden from assistive tech, and leaves the demo's saved state alone", async ({
  page,
}) => {
  await page.goto("/welcome");
  await expect(frame(page)).toBeVisible();
  const state = await frame(page).evaluate((el) => ({
    inert: el.hasAttribute("inert"),
    hidden: el.getAttribute("aria-hidden"),
    focusable: el.querySelectorAll(
      'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])',
    ).length,
  }));
  expect(state.inert).toBe(true);
  expect(state.hidden).toBe("true");
  // Only the preview's own tabs are operable; the screens inside are not.
  const reachable = await page.evaluate(() => {
    const shell = document.querySelector(".previewShell")!;
    return [...shell.querySelectorAll("button,input")].filter(
      (e) => (e as HTMLElement).tabIndex >= 0 && !e.closest("[inert]"),
    ).length;
  });
  expect(reachable).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("relay-current-demo-v5")),
  ).toBeNull();
  await expect(page.locator(".previewNote")).toContainText(
    "fictional sample data",
  );
});

for (const width of [1440, 390]) {
  test(`the home page has no accessibility violations or overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/welcome");
    await expect(frame(page).locator(".loadCard").first()).toBeVisible();
    expect(await scan(page)).toEqual([]);
    for (const tab of ["Table", "Calendar", "Documents"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(frame(page)).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
}

test("the copy promises what the product does: no tracking claims", async ({
  page,
}) => {
  await page.goto("/welcome");
  // The headline claims and the three cards must not promise tracking; the
  // guardrails section may name it, to say it is never presented as live.
  const claims = await page
    .locator(".mkHero, .mkGrid")
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).innerText).join(" "),
    );
  expect(claims).not.toMatch(/\btrack(ing|s)?\b/i);
  expect(claims).toContain("record every step");
});

test("the interactive demo's Documents page works, and approving a draft sticks", async ({
  page,
}) => {
  await page.goto("/demo");
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Documents" })
    .click();
  const drafts = page.getByRole("table");
  await expect(drafts.getByText("Check call")).toBeVisible();
  await expect(page.locator(".alert.error")).toHaveCount(0);
  await drafts.getByText("Broker update").click();
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(page.getByText("Marked as reviewed.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Approved/ }).click();
  await expect(drafts.getByText("Broker update")).toBeVisible();
  await page.getByRole("tab", { name: /Templates/ }).click();
  await expect(page.getByText("Carrier welcome")).toBeVisible();
});
