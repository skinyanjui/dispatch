import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const origin = "http://localhost:3000";
const day = (n: number) =>
  new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
async function login(page: Page) {
  const r = await page.request.post("/api/login", {
    headers: { Origin: origin },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(r.status()).toBe(200);
}
async function fixture(page: Page) {
  const me = await (await page.request.get("/api/me")).json();
  const ref = "REPAIR-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/onboarding/carriers", {
    headers: { Origin: origin },
    data: {
      organization_id: me.organizations[0].id,
      name: ref,
      contact_name: "Fictional manager",
      contact_email: ref.toLowerCase() + "@relay.test",
      key: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const agreement = await page.request.post(
    `/api/onboarding/carriers/${id}/agreement`,
    {
      headers: { Origin: origin },
      data: {
        key: randomUUID(),
        reference: "Fictional QA agreement",
        effective_date: day(30),
        through_date: day(-365),
        confirmed: true,
      },
    },
  );
  expect(agreement.status()).toBe(200);
  const loads = [];
  for (const offset of [2, 20]) {
    const start = Date.now() - offset * 86400000;
    const r = await page.request.post("/api/loads", {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: {
        carrierId: id,
        reference: ref + "-" + offset,
        source: "Fictional repair QA",
        amountMinor: 250000,
        stops: [
          {
            kind: "pickup",
            address: "Fictional Chicago",
            timezone: "America/Chicago",
            windowStart: new Date(start).toISOString(),
            windowEnd: new Date(start + 3600000).toISOString(),
          },
          {
            kind: "delivery",
            address: "Fictional Dallas",
            timezone: "America/Chicago",
            windowStart: new Date(start + 86400000).toISOString(),
            windowEnd: new Date(start + 90000000).toISOString(),
          },
        ],
      },
    });
    expect(r.status()).toBe(201);
    loads.push(await r.json());
  }
  return { id, ref, loads };
}

test("report drill-down dates, carrier, reload and Back/Forward retain the exact cohort", async ({
  page,
}) => {
  await login(page);
  const { id, ref, loads } = await fixture(page);
  const source = `/reports?carrier_id=${id}&from=${day(6)}&to=${day(0)}`;
  await page.goto(source);
  const region = page.getByRole("region", { name: "Reports", exact: true });
  await expect(
    region.locator(".stats").first().locator(".stat").first(),
  ).toContainText("1");
  await region.getByRole("button", { name: /^Loads 1 .*Open loads$/ }).click();
  await expect(page).toHaveURL(new RegExp("from=" + day(6)));
  await expect(
    page.getByRole("status").filter({ hasText: "Pickup dates:" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp("^" + ref + "-2(?: ·|$)") }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp("^" + ref + "-20(?: ·|$)") }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: new RegExp("^" + ref + "-2(?: ·|$)") }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp("^" + ref + "-2(?: ·|$)") })
    .click();
  await expect(page).toHaveURL(new RegExp("/loads/" + loads[0].id));
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Load details" })).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(new RegExp("from=" + day(6)));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("/reports\\?"));
  await expect(region).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp("from=" + day(6)));
  await expect(
    page.getByRole("button", { name: new RegExp("^" + ref + "-2(?: ·|$)") }),
  ).toBeVisible();
});

test("failed report filters keep a persistent stale identity and disable exporting stale results", async ({
  page,
}) => {
  await login(page);
  await page.goto("/reports");
  const region = page.getByRole("region", { name: "Reports", exact: true });
  await expect(region.locator(".reportExport")).toBeVisible();
  await page.route("**/api/reports?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "SERVICE_UNAVAILABLE" }),
    }),
  );
  await region
    .getByRole("button", { name: "Last 7 days", exact: true })
    .click();
  await expect(region.getByRole("alert")).toBeVisible();
  await expect(region.getByText(/Previous results —/)).toContainText(
    "not current",
  );
  await expect(region.locator(".reportExport")).toHaveCount(0);
  await expect(
    region.getByRole("status").filter({ hasText: "Report loaded" }),
  ).toHaveCount(0);
  await page.unroute("**/api/reports?*");
  await region.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(region.getByRole("alert")).toHaveCount(0);
  await expect(region.locator(".reportExport")).toBeVisible();
});

test("missing POD shortcut requests the precise current-version criterion and retains dates", async ({
  page,
}) => {
  await login(page);
  await page.goto("/reports");
  const region = page.getByRole("region", { name: "Reports", exact: true });
  await expect(region.locator(".reportExport")).toBeVisible();
  await region.getByRole("button", { name: "Show these loads" }).click();
  await expect(page).toHaveURL(/missing_pod=true/);
  await expect(page).toHaveURL(/status=delivered/);
  await expect(page).toHaveURL(/from=/);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Delivered without accepted current POD" }),
  ).toBeVisible();
});

test("large export is queued durably, becomes downloadable, and resumes after reload", async ({
  page,
}) => {
  await login(page);
  await page.goto("/reports");
  const region = page.getByRole("region", { name: "Reports", exact: true });
  await expect(region.locator(".reportExport")).toBeVisible();
  await region.getByText("Larger exports", { exact: true }).click();
  await region.getByRole("button", { name: "Prepare larger export" }).click();
  await expect(page).toHaveURL(/export_id=/);
  const link = region.getByRole("link", { name: "Download complete export" });
  await expect(link).toBeVisible({ timeout: 20000 });
  await page.reload();
  await region.getByText("Larger exports", { exact: true }).click();
  await expect(link).toBeVisible();
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toMatch(/^relay-loads-/);
});

test("demo report download uses fictional browser data without authenticated API calls", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(r.url());
  });
  await page.goto("/demo");
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Reports", exact: true })
    .click();
  const link = page.getByRole("link", { name: "Export loads (CSV)" });
  await expect(link).toBeVisible();
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("relay-demo-loads.csv");
  expect(calls).toEqual([]);
});

test("Inbox reports failed, unknown and confirmed text outcomes without claiming a Relay delivery", async ({
  page,
}) => {
  await login(page);
  const me = await (await page.request.get("/api/me")).json();
  const name = "Receipt-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/contacts", {
    headers: { Origin: origin },
    data: {
      idempotency_key: randomUUID(),
      organization_id: me.organizations[0].id,
      kind: "broker",
      name,
      phone: "+12145550114",
      sms_consent: true,
      sms_consent_note: "Fictional UI fixture consent",
    },
  });
  expect(created.status()).toBe(201);
  const contact = await created.json();
  const logged = await page.request.post("/api/messages", {
    headers: { Origin: origin },
    data: {
      idempotency_key: randomUUID(),
      to: ["contact:" + contact.id],
      mode: "log",
      channel: "sms",
      direction: "out",
      body: "Fictional conversation setup",
      subject: name,
    },
  });
  expect(logged.status()).toBe(201);
  const saved = await logged.json();
  await page.route("**/api/messaging/capabilities", (route) =>
    route.fulfill({
      status: 200,
      json: { in_app: true, email: false, sms: true },
    }),
  );
  let state = "unknown";
  await page.route("**/api/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 201,
      json: {
        thread_id: saved.thread_id,
        message_id: randomUUID(),
        processingState: state,
        deliveries: [{ channel: "sms", status: state }],
      },
    });
  });
  await page.goto("/inbox");
  const inbox = page.getByRole("region", { name: "Inbox" });
  await inbox
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  for (const [outcome, notice] of [
    ["unknown", "provider outcome is unknown"],
    ["failed", "delivery failed"],
    ["delivered", "Provider delivery confirmed."],
  ]) {
    state = outcome;
    const composer = inbox.getByRole("form", { name: "Write a message" });
    await composer.getByRole("button", { name: "Text", exact: true }).click();
    await composer.locator("textarea").fill("Fictional " + outcome);
    await composer.getByRole("button", { name: "Send", exact: true }).click();
    await expect(inbox.getByText(new RegExp(notice))).toBeVisible();
    await expect(
      inbox.getByText("Message available in Relay.", { exact: true }),
    ).toHaveCount(0);
  }
});

test("repaired reports support keyboard use, narrow reflow and automated accessibility checks", async ({
  page,
}) => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  await login(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/reports");
  const region = page.getByRole("region", { name: "Reports", exact: true });
  await expect(region.locator(".reportExport")).toBeVisible();
  await region.getByText("Larger exports", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    region.getByRole("button", { name: "Prepare larger export" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await region
      .locator(".stat small")
      .evaluateAll((labels) =>
        labels.every((label) => label.scrollWidth <= label.clientWidth + 1),
      ),
  ).toBe(true);
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Element,
          ) => Promise<{ violations: { id: string; impact: string }[] }>;
        };
      }
    ).axe;
    return (await axe.run(document.querySelector("main")!)).violations.filter(
      (v) => ["critical", "serious"].includes(v.impact),
    );
  });
  expect(violations).toEqual([]);
  await page.screenshot({
    path: "artifacts/repair-report-mobile.png",
    fullPage: true,
  });
});
