import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

/**
 * The money controls on screen (ADRs 0064-0069): cash and factoring tabs on
 * Billing, registration and payout approvals in a carrier's files, and the
 * Claims tab on a load. The browser-only demo has none of them and says nothing
 * about them.
 */
const origin = { Origin: "http://localhost:3000" };
async function login(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: origin,
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(response.status()).toBe(200);
}
async function blueRidge(page: Page) {
  const context = await (await page.request.get("/api/me")).json();
  return context.carriers.find((c: { name: string }) =>
    c.name.startsWith("Blue Ridge"),
  ).id as string;
}
async function createLoad(page: Page, carrier: string) {
  const reference = "MON-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/loads", {
    headers: { ...origin, "Idempotency-Key": randomUUID() },
    data: {
      carrierId: carrier,
      reference,
      source: "Fictional money controls browser QA",
      amountMinor: 250000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: "2026-11-05T15:00:00Z",
          windowEnd: "2026-11-05T16:00:00Z",
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: "2026-11-06T15:00:00Z",
          windowEnd: "2026-11-06T16:00:00Z",
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  return { id: (await created.json()).id as string, reference };
}
async function axeViolations(page: Page) {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  return page.evaluate(async () => {
    const result = await (
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
    return result.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  });
}

test("Billing has Cash and Factoring tabs: figures, a fee preview that refuses nonsense, and no horizontal scroll on a phone", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/billing");
  await page.getByRole("tab", { name: /^Cash/ }).click();
  await expect(page.getByRole("group", { name: "Cash summary" })).toBeVisible();
  // Each list is a table when it has rows and an explained empty state when not
  // (a fresh database has no delivered loads).
  await expect(
    page
      .getByRole("table", { name: /Delivered loads: what each earned/ })
      .or(page.getByText("No delivered loads yet")),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: /paperwork still to do/ })
      .or(page.getByText("Nothing is waiting on paperwork")),
  ).toBeVisible();
  // A fee preview is checked before it is sent.
  await page.getByLabel("Preview a dispatch fee (%)").fill("abc");
  await page.getByRole("button", { name: "Show estimate" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /percentage/ })
      .or(page.getByRole("alert").filter({ hasText: /percentage/ })),
  ).toBeVisible();
  await page.getByLabel("Preview a dispatch fee (%)").fill("8.5");
  await page.getByRole("button", { name: "Show estimate" }).click();
  await expect(page.locator(".alert.error")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("tab", { name: /^Factoring/ }).click();
  // A dispatcher is never offered the consent form, whatever the state.
  await expect(
    page.getByRole("heading", { name: "Sharing with a factor" }),
  ).toBeVisible();
  await expect(page.getByLabel("Factor's name")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of [/^Cash/, /^Factoring/]) {
    await page.getByRole("tab", { name: tab }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test("the carrier's manager turns on factoring with explicit consent", async ({
  page,
}) => {
  await login(page, "carrier@relay.test");
  await page.goto("/billing");
  await page.getByRole("tab", { name: /^Factoring/ }).click();
  const turnOn = page.getByRole("button", { name: /^(Turn on|Save)$/ });
  await page.getByLabel("Factor's name").fill("Fictional Factor Co");
  await expect(turnOn).toBeDisabled(); // no consent yet
  await page.getByLabel(/I agree to share this carrier's billing data/).check();
  await turnOn.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Sharing is on" }),
  ).toBeVisible();
  await expect(
    page.getByText(/agreed on .* to share this carrier's billing data with/),
  ).toBeVisible();
});

test("a payout change waits for a second person who says how they checked it", async ({
  page,
}) => {
  await login(page);
  const carrier = await blueRidge(page);
  await page.goto(`/carriers/${carrier}/documents`);
  const dialog = page.getByRole("dialog", { name: "Carrier documents" });
  await expect(
    dialog.getByRole("heading", { name: "Public registration" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Change payout details" }).click();
  await dialog.getByLabel("Payee name").fill("Fictional Payee LLC");
  await dialog.getByLabel("Last four digits (optional)").fill("1234");
  await dialog.getByLabel("Why it is changing").fill("Carrier changed banks");
  await dialog.getByRole("button", { name: "Ask for approval" }).click();
  const pending = dialog.getByRole("article", {
    name: /Payout to Fictional Payee LLC/,
  });
  await expect(pending).toBeVisible();
  // The person who asked can withdraw it but cannot approve it.
  await expect(pending.getByRole("button", { name: /^Review/ })).toHaveCount(0);
  await expect(pending.getByRole("button", { name: "Withdraw" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The carrier's manager reviews it.
  await page.context().clearCookies();
  await login(page, "carrier@relay.test");
  // They are told on any page that a change is waiting, with a link to it.
  await page.goto("/");
  const banner = page.getByRole("region", {
    name: "Changes waiting for your approval",
  });
  await expect(banner).toContainText("waiting for your approval");
  await expect(
    banner.getByRole("link", { name: /^Review Blue Ridge/ }),
  ).toHaveAttribute("href", `/carriers/${carrier}/documents`);
  await page.goto(`/carriers/${carrier}/documents`);
  const mine = page
    .getByRole("dialog", { name: "Carrier documents" })
    .getByRole("article", { name: /Payout to Fictional Payee LLC/ });
  await mine.getByRole("button", { name: /^Review/ }).click();
  const form = page.getByRole("form", {
    name: /Decide: Payout to Fictional Payee LLC/,
  });
  await expect(form).toContainText("Confirm it another way");
  await form.getByLabel("How you confirmed it").selectOption("callback");
  // Approving needs the password again; a wrong one changes nothing and keeps the form.
  await expect(form.getByRole("button", { name: "Approve" })).toBeDisabled();
  await form.getByLabel("Your password").fill("not my password");
  await form.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByRole("dialog", { name: "Carrier documents" }).getByRole("alert"),
  ).toContainText("That password didn't match");
  await expect(form).toBeVisible();
  await form.getByLabel("Your password").fill(process.env.SEED_PASSWORD!);
  await form.getByRole("button", { name: "Approve" }).click();
  const dialog2 = page.getByRole("dialog", { name: "Carrier documents" });
  await expect(
    dialog2.getByRole("status").filter({ hasText: "Approved." }),
  ).toBeVisible();
  await expect(dialog2).toContainText(
    /Fictional Payee LLC.*account ending 1234/,
  );
  await expect(dialog2).toContainText(/cooling off until/);
});

test("a load's Claims tab shows the terms, each stop's detention arithmetic and TONU eligibility", async ({
  page,
}) => {
  await login(page);
  const carrier = await blueRidge(page);
  const load = await createLoad(page, carrier);
  await page.goto(`/loads/${load.id}`);
  const dialog = page.getByRole("dialog", { name: "Load details" });
  await dialog.getByRole("tab", { name: /^Claims/ }).click();
  await expect(dialog.getByRole("heading", { name: "Terms" })).toBeVisible();
  await expect(dialog.getByRole("article", { name: "Stop 1" })).toContainText(
    "No terms set",
  );
  await expect(dialog.getByText("The load was not cancelled.")).toBeVisible();
  await dialog.getByLabel("Detention per hour ($)").fill("60");
  await dialog.getByLabel("TONU fee ($, optional)").fill("150");
  await dialog.getByRole("button", { name: "Save terms" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Terms saved." }),
  ).toBeVisible();
  // With terms but no recorded times, the stop says what is missing.
  await expect(dialog.getByRole("article", { name: "Stop 1" })).toContainText(
    "No arrival recorded",
  );
  // A bad amount is refused before it is sent.
  await dialog.getByLabel("Detention per hour ($)").fill("sixty");
  await dialog.getByRole("button", { name: "Save terms" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/USD amount/);
  expect(await axeViolations(page)).toEqual([]);
});

test("the browser-only demo has no cash, factoring or claims screens to mislead anyone", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await nav.getByRole("button", { name: "Billing", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Invoices/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Cash/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Factoring/ })).toHaveCount(0);
});
