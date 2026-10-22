import { test, expect, type Page } from "@playwright/test";
import type { CheckIn, CheckInInput } from "../../src/lib/contracts";

// Local route stubs isolate the reviewed failures without altering QA records.
test.use({ viewport: { width: 1440, height: 1000 } });

const carrierId = "11111111-1111-4111-8111-111111111111";
const otherCarrierId = "33333333-3333-4333-8333-333333333333";
const loadId = "22222222-2222-4222-8222-222222222222";
const otherLoadId = "44444444-4444-4444-8444-444444444444";
const carriers = [
  { id: carrierId, name: "North QA Transport", role: "dispatcher" },
  { id: otherCarrierId, name: "South QA Logistics", role: "dispatcher" },
];

function fixture(id = loadId, carrier = carriers[0]) {
  return {
    id,
    carrier_id: carrier.id,
    carrier_name: carrier.name,
    reference: "SHARED-REF",
    stage: "booked",
    amount_minor: "250000",
    pickup: "Chicago, IL",
    delivery: "Nashville, TN",
    created_at: "2026-10-21T10:00:00Z",
    version: 1,
    source: "Fictional audit regression",
    assignment: null,
    events: [],
    stops: [
      {
        kind: "pickup",
        address: "Chicago, IL",
        window_start: "2026-11-05T15:00:00Z",
        window_end: "2026-11-05T18:00:00Z",
        timezone: "America/Chicago",
      },
      {
        kind: "delivery",
        address: "Nashville, TN",
        window_start: "2026-11-06T03:00:00Z",
        window_end: "2026-11-06T14:00:00Z",
        timezone: "America/Chicago",
      },
    ],
  };
}

async function mockContext(page: Page) {
  await page.route("**/api/loads/*/notes", (route) =>
    route.fulfill({ json: { notes: [] } }),
  );
  await page.route("**/api/carriers/summary", (route) =>
    route.fulfill({
      json: { carriers: [], generated_at: new Date().toISOString() },
    }),
  );
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: { user: { name: "Audit QA" }, carriers, drivers: [] },
    }),
  );
}

test("a failed sign out remains visible in the carrier directory", async ({
  page,
}) => {
  await mockContext(page);
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads: [], nextCursor: null } }),
  );
  await page.route("**/api/logout", (route) =>
    route.fulfill({ status: 503, json: { error: "SERVICE_UNAVAILABLE" } }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Carrier accounts", exact: true }),
  ).toBeAttached();
  await expect(main.getByRole("alert")).toContainText(
    "We couldn't reach Relay just now.",
  );
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
});

test("creating a load from the carrier directory shows its saved acknowledgment", async ({
  page,
}) => {
  await mockContext(page);
  const load = { ...fixture(), reference: "DIRECTORY-CREATE-QA" };
  let saved = false;
  let posts = 0;
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({
      json: { loads: saved ? [load] : [], nextCursor: null },
    }),
  );
  await page.route("**/api/loads", (route) => {
    saved = true;
    posts++;
    return route.fulfill({ status: 201, json: load });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  await page.getByRole("button", { name: "New load", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create load" });
  await modal.getByLabel("Load reference").fill(load.reference);
  await modal.getByLabel("Booking source").fill(load.source);
  await modal.getByLabel("Agreed rate").fill("2500.00");
  for (const kind of ["pickup", "delivery"]) {
    const stop = modal.getByRole("group", { name: kind, exact: true });
    await stop
      .getByLabel("Address")
      .fill(kind === "pickup" ? "Chicago, IL" : "Nashville, TN");
    await stop
      .getByLabel("Appointment")
      .fill(kind === "pickup" ? "2026-11-05T09:00" : "2026-11-06T09:00");
  }
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal).not.toBeVisible();
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Carrier accounts", exact: true }),
  ).toBeVisible();
  await expect(
    main.getByText("Booked load created.", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("load details preserve same-day and overnight appointment windows", async ({
  page,
}) => {
  await mockContext(page);
  const load = fixture();
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads: [load], nextCursor: null } }),
  );
  await page.route("**/api/loads/" + load.id, (route) =>
    route.fulfill({ json: load }),
  );

  await page.goto("/");
  await page
    .getByRole("button", {
      name: "SHARED-REF · North QA Transport",
      exact: true,
    })
    .click();
  const record = page.getByRole("dialog", { name: "Load details" });
  await record.getByRole("tab", { name: /^Route/ }).click();
  const stops = record.locator(".stop");
  await expect(stops.nth(0)).toContainText("9:00 AM");
  await expect(stops.nth(0)).toContainText("12:00 PM");
  await expect(stops.nth(1)).toContainText("Nov 5");
  await expect(stops.nth(1)).toContainText("Nov 6");
  await expect(stops.nth(1)).toContainText("9:00 PM");
  await expect(stops.nth(1)).toContainText("8:00 AM");
  await expect(stops.nth(1)).toContainText("America/Chicago");
});

test("list actions distinguish the same reference across carriers", async ({
  page,
}) => {
  await mockContext(page);
  const loads = [fixture(), fixture(otherLoadId, carriers[1])];
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads, nextCursor: null } }),
  );
  for (const load of loads) {
    await page.route("**/api/loads/" + load.id, (route) =>
      route.fulfill({ json: load }),
    );
  }

  await page.goto("/");
  const table = page.getByRole("region", { name: "Load workspace" });
  for (const carrier of carriers) {
    await expect(
      table.getByRole("button", {
        name: "SHARED-REF · " + carrier.name,
        exact: true,
      }),
    ).toBeVisible();
  }
  await table
    .getByRole("button", {
      name: "SHARED-REF · North QA Transport",
      exact: true,
    })
    .click();
  let details = page.getByRole("dialog", { name: "Load details" });
  await expect(details.locator(".detailCarrier")).toContainText(
    "North QA Transport",
  );
  await details.getByRole("button", { name: "Close load details" }).click();
  await table
    .getByRole("button", {
      name: "SHARED-REF · South QA Logistics",
      exact: true,
    })
    .click();
  details = page.getByRole("dialog", { name: "Load details" });
  await expect(details.locator(".detailCarrier")).toContainText(
    "South QA Logistics",
  );
});

test("refreshing after a lost check-in response preserves the original retry identity", async ({
  page,
}) => {
  await mockContext(page);
  const load = fixture();
  const reports: CheckIn[] = [];
  const inputs: CheckInInput[] = [];
  const committedKeys = new Set<string>();
  let version = 1;
  let loseResponse = true;
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({
      json: { loads: [{ ...load, version }], nextCursor: null },
    }),
  );
  await page.route("**/api/loads/" + load.id, (route) =>
    route.fulfill({ json: { ...load, version, check_ins: reports } }),
  );
  await page.route("**/api/loads/" + load.id + "/check-ins", (route) => {
    const input = route.request().postDataJSON() as CheckInInput;
    inputs.push(input);
    // Model the server committing before the first response is lost. Only an
    // unchanged retry key can replay that result without another observation.
    if (!committedKeys.has(input.idempotency_key)) {
      committedKeys.add(input.idempotency_key);
      version++;
      reports.unshift({
        id: input.idempotency_key,
        location: input.location,
        note: input.note,
        observed_at: input.observed_at,
        recorded_at: new Date().toISOString(),
        actor_name: "Audit QA",
        source: "manual",
      });
    }
    if (loseResponse) {
      loseResponse = false;
      return route.abort("failed");
    }
    return route.fulfill({ json: { version } });
  });

  await page.goto("/");
  await page
    .getByRole("button", {
      name: "SHARED-REF · North QA Transport",
      exact: true,
    })
    .click();
  const details = page.getByRole("dialog", { name: "Load details" });
  await details.getByRole("tab", { name: /^Check-ins/ }).click();
  await details
    .getByRole("button", { name: "Add check-in", exact: true })
    .click();
  const form = details.getByRole("form", { name: "Record manual check-in" });
  await form
    .getByLabel("Reported location", { exact: true })
    .fill("Memphis, TN");
  await form.getByLabel("Check-in note").fill("Fictional phone report");
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  await expect(details.getByRole("alert")).toContainText(
    "couldn't reach Relay",
  );

  await details
    .getByRole("button", { name: "Refresh load details", exact: true })
    .click();
  await expect(
    details.getByRole("article", {
      name: "Check-in: Memphis, TN",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    form.getByLabel("Reported location", { exact: true }),
  ).toHaveValue("Memphis, TN");
  await form
    .getByRole("button", { name: "Record check-in", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await expect(
    details.getByText("Manual check-in recorded.", { exact: true }),
  ).toBeVisible();
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(inputs.map((input) => input.version)).toEqual([1, 1]);
  expect(reports).toHaveLength(1);
});
