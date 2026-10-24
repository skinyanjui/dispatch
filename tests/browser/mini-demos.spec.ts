import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

/**
 * The public pages show the product instead of describing it: small working
 * interactions built from the real components and the demo's own rules. They
 * must work from the keyboard, use the real refusal messages, and stay inside
 * their own private sample data.
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
const frame = (page: Page, title: string) =>
  page
    .getByRole("figure", { name: title })
    .or(page.locator("figure.miniFrame", { hasText: title }))
    .first();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("home: another carrier's driver is refused in the real words, then the right driver can be assigned and dispatched", async ({
  page,
}) => {
  await page.goto("/welcome");
  const mini = frame(page, "Book and dispatch");
  await expect(mini.locator(".loadCard")).toContainText("Needs a driver");
  await mini
    .getByRole("combobox", { name: "Driver" })
    .selectOption({ label: "Morgan Reed · Prairie Line Logistics" });
  await mini.getByRole("button", { name: "Assign driver" }).click();
  await expect(mini.getByRole("status")).toHaveText(
    "Please choose a driver who works with this carrier.",
  );
  await expect(mini.locator(".loadCard")).toContainText("Needs a driver");
  await mini
    .getByRole("combobox", { name: "Driver" })
    .selectOption({ label: "Jordan Ellis · Blue Ridge Transport" });
  await mini.getByRole("button", { name: "Assign driver" }).click();
  await expect(mini.getByRole("status")).toHaveText("Driver assigned.");
  await expect(mini.locator(".loadCard")).toContainText("Jordan Ellis");
  await mini.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(mini.getByRole("status")).toContainText("Dispatched");
  await expect(
    mini.getByRole("button", { name: "Dispatch", exact: true }),
  ).toBeDisabled();
  await mini.getByRole("button", { name: "Start over" }).click();
  await expect(mini.locator(".loadCard")).toContainText("Needs a driver");
});

test("home: dispatching before a driver is assigned says what to do first", async ({
  page,
}) => {
  await page.goto("/welcome");
  const mini = frame(page, "Book and dispatch");
  await mini.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(mini.getByRole("status")).toHaveText(
    "Assign a driver first, then you can dispatch.",
  );
});

test("home: a check-in keeps its source and the time it was observed", async ({
  page,
}) => {
  await page.goto("/welcome");
  const mini = frame(page, "Follow and resolve");
  await expect(mini.getByText("Columbus, OH")).toBeVisible();
  await expect(mini.getByText(/Alex Morgan · Manual/)).toBeVisible();
  await mini.getByRole("button", { name: /Add check-in/ }).click();
  await mini.getByLabel("Reported location").fill("Nashville, TN");
  await mini
    .getByRole("button", { name: /Record|Save|Add/ })
    .last()
    .click();
  await expect(mini.getByText("Nashville, TN").first()).toBeVisible();
});

test("home: the carrier's packet and your invoice move independently", async ({
  page,
}) => {
  await page.goto("/welcome");
  const mini = frame(page, "Bill, separately");
  const summary = mini.getByRole("status");
  await expect(summary).toHaveText("Packet: Draft. Invoice: Draft.");
  await mini.getByRole("button", { name: "Mark submitted to broker" }).click();
  await expect(summary).toHaveText(
    "Packet: Submitted to broker. Invoice: Draft.",
  );
  await mini.getByRole("button", { name: "Mark issued" }).click();
  await mini.getByRole("button", { name: "Mark paid by carrier" }).click();
  await expect(summary).toHaveText(
    "Packet: Submitted to broker. Invoice: Paid by carrier.",
  );
  // $2,450.00 freight and an 8% fee of $196.00, in whole cents.
  await expect(mini).toContainText("$2,450.00");
  await expect(mini).toContainText("$196.00");
});

test("home: a draft flags what is missing, and review is a person's act", async ({
  page,
}) => {
  await page.goto("/welcome");
  const mini = frame(page, "Draft from a template");
  await expect(mini.locator("mark").first()).toContainText(
    "[missing: load.driver]",
  );
  await expect(mini.getByRole("status")).toContainText("Missing: load.driver");
  await mini
    .getByRole("combobox")
    .selectOption({ label: "RL-102 · Prairie Line Logistics" });
  await expect(mini.locator("mark")).toContainText(
    "[missing: load.next_appointment]",
  );
  await mini.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(mini.getByText("Reviewed", { exact: true })).toBeVisible();
});

test("pricing: AI is off until it is switched on", async ({ page }) => {
  await page.goto("/pricing");
  const mini = frame(page, "AI is off until you turn it on");
  const toggle = mini.getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(mini.getByRole("status")).toContainText(
    "Nothing is read or written by AI",
  );
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(mini.getByRole("status")).toContainText(
    "billed to your own account",
  );
});

test("how it works and get started show each step instead of describing it", async ({
  page,
}) => {
  for (const [path, steps] of [
    ["/how-it-works", 6],
    ["/get-started", 6],
  ] as const) {
    await page.goto(path);
    const items = page.locator(".stepShow > li");
    await expect(items).toHaveCount(steps);
    for (let i = 0; i < steps; i++)
      await expect(items.nth(i).locator(".stepMedia > *")).not.toHaveCount(0);
    // Each step's words are one short sentence, not a paragraph.
    const longest = await items
      .locator(".stepText p")
      .evaluateAll((ps) =>
        Math.max(...ps.map((p) => (p.textContent ?? "").length)),
      );
    expect(longest).toBeLessThan(90);
    await expect(page.locator(".miniNote")).toHaveCount(1);
  }
  await page.goto("/how-it-works");
  await expect(
    page.getByText("This carrier needs a current, verified dispatch agreement"),
  ).toBeVisible();
});

test("the interactions never touch the demo's saved state", async ({
  page,
}) => {
  await page.goto("/welcome");
  const mini = frame(page, "Book and dispatch");
  await expect(mini.locator(".loadCard")).toBeVisible();
  await mini.getByRole("button", { name: "Dispatch", exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("relay-current-demo-v5")),
  ).toBeNull();
});

for (const path of ["/welcome", "/how-it-works", "/get-started", "/pricing"])
  test(`${path}: interactions have no accessibility violations`, async ({
    page,
  }) => {
    await page.goto(path);
    await page.waitForTimeout(1800);
    expect(await scan(page)).toEqual([]);
  });
