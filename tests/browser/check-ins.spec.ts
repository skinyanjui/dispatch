import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

test("sign-in explains administrator access and fictional QA account choices", async ({
  page,
}) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } }),
  );
  await page.goto("/");
  const guidance = page.locator(".loginAccess");
  await expect(
    guidance.getByText("dispatcher@relay.test", { exact: true }),
  ).not.toBeVisible();
  await guidance.getByText("How do I get access?", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(guidance).toContainText(
    "Use “Forgot password?” to reset a password by email",
  );
  for (const email of [
    "dispatcher@relay.test",
    "carrier@relay.test",
    "driver@relay.test",
  ])
    await expect(guidance.getByText(email, { exact: true })).toBeVisible();
  await expect(guidance).toContainText("QA password set by your administrator");
});

async function login(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(response.status()).toBe(200);
}

async function fixture(page: Page, carrierId?: string) {
  const context = await (await page.request.get("/api/me")).json();
  const carrier =
    carrierId ||
    context.carriers.find((c: { name: string }) =>
      c.name.startsWith("Blue Ridge"),
    ).id;
  const reference = "CHECKIN-UI-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/loads", {
    headers: {
      Origin: "http://localhost:3000",
      "Idempotency-Key": randomUUID(),
    },
    data: {
      carrierId: carrier,
      reference,
      source: "Fictional check-in browser QA",
      amountMinor: 120000,
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
  return { ...(await created.json()), context };
}

async function open(page: Page, reference: string) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Search loads" }).fill(reference);
  await page.getByRole("button", { name: new RegExp("^" + reference) }).click();
  const dialog = page.getByRole("dialog", { name: "Load details" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("manual reports show stale observation time, receipt time and authenticated reporter", async ({
  page,
}) => {
  await login(page);
  const load = await fixture(page);
  const dialog = await open(page, load.reference);
  await dialog.getByRole("button", { name: "Add check-in" }).click();
  const form = dialog.getByRole("form", { name: "Record manual check-in" });
  await form.getByLabel("Reported location").fill("Joliet, IL");
  await form
    .getByLabel("Observed time")
    .fill(new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 16));
  await form.getByLabel("Time zone").selectOption("UTC");
  await form
    .getByLabel(/Check-in note/)
    .fill("Fictional driver report: resting before pickup.");
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  const report = dialog.getByRole("article", { name: "Check-in: Joliet, IL" });
  await expect(report).toBeVisible();
  await expect(report.getByText("Stale", { exact: true })).toBeVisible();
  await expect(report).toContainText("Observed 3h ago");
  await expect(report).toContainText(load.context.user.name + " · Manual");
  await expect(report.locator("time")).toHaveCount(2);
  await expect(dialog.locator(".badge")).toHaveText("Booked");
  await expect(
    dialog.locator(".event").filter({ hasText: "Manual check-in recorded" }),
  ).toHaveCount(1);
  const detail = await (await page.request.get("/api/loads/" + load.id)).json();
  expect(detail.check_ins).toHaveLength(1);
  expect(detail.version).toBe(2);
  expect(detail.stage).toBe("booked");
});

test("assigned driver can report from a phone without milestone or assignment access", async ({
  page,
}) => {
  await login(page, "driver@relay.test");
  const driver = await (await page.request.get("/api/me")).json();
  await login(page);
  const load = await fixture(page, driver.carriers[0].id);
  const assigned = load.context.drivers.find(
    (d: { name: string; carrier_id: string }) =>
      d.name === driver.user.name && d.carrier_id === load.carrier_id,
  );
  expect(assigned).toBeTruthy();
  const response = await page.request.post(
    "/api/loads/" + load.id + "/assign",
    {
      headers: { Origin: "http://localhost:3000" },
      data: { version: 1, driverId: assigned.id },
    },
  );
  expect(response.status()).toBe(200);
  await login(page, "driver@relay.test");
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await open(page, load.reference);
  await expect(
    dialog.getByRole("button", { name: "Assign driver", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Record next milestone" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add check-in" }).click();
  const form = dialog.getByRole("form", { name: "Record manual check-in" });
  await form.getByLabel("Reported location").fill("At Chicago pickup gate");
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  const report = dialog.getByRole("article", {
    name: "Check-in: At Chicago pickup gate",
  });
  await expect(report).toContainText(driver.user.name + " · Manual");
  expect(
    await dialog
      .locator(".inspector")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("known version conflicts preserve entries and allow a new attempt after detail refresh", async ({
  page,
}) => {
  await login(page);
  const load = await fixture(page);
  const dialog = await open(page, load.reference);
  await dialog.getByRole("button", { name: "Add check-in" }).click();
  const form = dialog.getByRole("form", { name: "Record manual check-in" });
  await form.getByLabel("Reported location").fill("Gary, IN");
  const driver = load.context.drivers.find(
    (d: { carrier_id: string }) => d.carrier_id === load.carrier_id,
  );
  expect(
    (
      await page.request.post("/api/loads/" + load.id + "/assign", {
        headers: { Origin: "http://localhost:3000" },
        data: { version: 1, driverId: driver.id },
      })
    ).status(),
  ).toBe(200);
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Someone just updated this load",
  );
  await dialog.getByRole("button", { name: "Refresh load details" }).click();
  await expect(form.getByLabel("Reported location")).toHaveValue("Gary, IN");
  await expect(
    form.getByRole("button", { name: "Record check-in", exact: true }),
  ).toBeEnabled();
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  const detail = await (await page.request.get("/api/loads/" + load.id)).json();
  expect(detail.version).toBe(3);
  expect(detail.check_ins).toHaveLength(1);
});

test("a saved report is acknowledged when reloading its detail fails", async ({
  page,
}) => {
  await login(page);
  const load = await fixture(page);
  const dialog = await open(page, load.reference);
  let first = true;
  await page.route("**/api/loads/" + load.id, (route) => {
    if (!first) return route.continue();
    first = false;
    return route.fulfill({
      status: 503,
      json: { error: "SERVICE_UNAVAILABLE" },
    });
  });
  await dialog.getByRole("button", { name: "Add check-in" }).click();
  const form = dialog.getByRole("form", { name: "Record manual check-in" });
  await form.getByLabel("Reported location").fill("Fictional rest stop");
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(
    "Manual check-in recorded.",
  );
  await expect(dialog.getByRole("alert")).toContainText("couldn't reach Relay");
  await dialog.getByRole("button", { name: "Refresh load details" }).click();
  await expect(
    dialog.getByRole("article", { name: "Check-in: Fictional rest stop" }),
  ).toBeVisible();
  const detail = await (await page.request.get("/api/loads/" + load.id)).json();
  expect(detail.check_ins).toHaveLength(1);
});
