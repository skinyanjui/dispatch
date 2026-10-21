import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";
import pg from "pg";
import { hashNewPassword } from "../../src/lib/auth";
import { codeAt, stepAt } from "../../src/lib/totp";

const origin = { Origin: "http://localhost:3000" };
const pdf = (label: string) => ({
  name: label + ".pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(
    `%PDF-1.4\n% fictional ${label} ${randomUUID()}\n%%EOF\n`,
  ),
});

async function login(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: origin,
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(response.status()).toBe(200);
}
async function blueRidge(page: Page) {
  const context = await (await page.request.get("/api/me")).json();
  return {
    carrier: context.carriers.find((c: { name: string }) =>
      c.name.startsWith("Blue Ridge"),
    ).id as string,
    driver: context.drivers.find(
      (d: { name: string }) => d.name === "Jordan Ellis",
    )?.id as string,
  };
}
async function createLoad(page: Page, carrier: string, prefix: string) {
  const reference = prefix + "-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/loads", {
    headers: { ...origin, "Idempotency-Key": randomUUID() },
    data: {
      carrierId: carrier,
      reference,
      source: "Fictional operations browser QA",
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
  return { ...(await created.json()), reference };
}
async function openLoad(page: Page, reference: string) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Search loads" }).fill(reference);
  await page.getByRole("button", { name: new RegExp("^" + reference) }).click();
  const dialog = page.getByRole("dialog", { name: "Load details" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the board answers the usual questions without opening a load", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const reference = "ANSWER-" + randomUUID().slice(0, 6);
  const soon = Date.now() + 2 * 3600000;
  const created = await page.request.post("/api/loads", {
    headers: { ...origin, "Idempotency-Key": randomUUID() },
    data: {
      carrierId: carrier,
      reference,
      source: "Fictional answers QA",
      amountMinor: 250000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: new Date(soon).toISOString(),
          windowEnd: new Date(soon + 3600000).toISOString(),
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: new Date(soon + 86400000).toISOString(),
          windowEnd: new Date(soon + 90000000).toISOString(),
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  // Actions a person must take before each answer is on screen.
  let actions = 0;
  await page.goto("/");
  const card = page.getByRole("button", { name: new RegExp("^" + reference) });
  // "What is next for this load, who has it, how is its paperwork?"
  await expect(card).toContainText(/Pickup in (1h|2h)/);
  await expect(card).toContainText("No driver");
  await expect(card).toContainText("Docs 0/3");
  expect(actions, "answers are visible on arrival").toBe(0);
  // "What needs me right now?" is one glance, and one click to act on it.
  const strip = page.getByRole("region", { name: "Needs attention" });
  await expect(strip).toContainText("need attention");
  const chips = strip.getByRole("group", { name: "Show only" });
  await expect(
    chips.getByRole("button", { name: /^Next 4 hours/ }),
  ).toBeVisible();
  actions++;
  await chips.getByRole("button", { name: /^Next 4 hours/ }).click();
  await expect(card).toBeVisible();
  await expect(
    chips.getByRole("button", { name: /^Next 4 hours/ }),
  ).toHaveAttribute("aria-pressed", "true");
  // Only loads in that group remain on the board.
  for (const other of await page.locator(".loadCard").all())
    await expect(other.locator(".cardStep")).toContainText(/Pickup|window|due/);
  expect(actions, "the attention list takes one click").toBe(1);
  await strip.getByRole("button", { name: "Show all loads" }).click();
  await expect(
    chips.getByRole("button", { name: /^Next 4 hours/ }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("AI reading: an admin opts in, a dispatcher reads a rate confirmation and checks the suggestions", async ({
  page,
}) => {
  await login(page);
  // The server under test uses the labelled sample provider (no network).
  await page.goto("/");
  await page.locator("button:has-text('Alex Morgan')").first().click();
  await page
    .locator(".accountMenu")
    .getByRole("button", { name: "Organization", exact: true })
    .click();
  const card = page.getByRole("article", { name: "AI document reading" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(
    "W-9s and dispatch agreements are never sent",
  );
  await card.getByLabel("Allow AI reading for this organization").check();
  await card.getByLabel("Monthly limit (USD)").fill("5");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(
    card.getByRole("status").filter({ hasText: "is on" }),
  ).toBeVisible();

  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "AI");
  const dialog = await openLoad(page, load.reference);
  const rate = dialog.getByRole("article", { name: "Rate confirmation" });
  await expect(rate.getByRole("button", { name: "Read with AI" })).toHaveCount(
    0,
  );
  await rate.getByLabel("Upload file").setInputFiles(pdf("ratecon"));
  await rate.getByRole("button", { name: "Upload Rate confirmation" }).click();
  await expect(rate).toContainText("v1 · ratecon.pdf");
  await rate.getByRole("button", { name: "Read with AI" }).click();
  const reading = rate.getByRole("region", {
    name: "AI reading of Rate confirmation",
  });
  await expect(reading).toContainText("Sample values. No AI was used.");
  await expect(
    reading.getByRole("list", { name: "Suggested values" }),
  ).toContainText("$2,600.00");
  // Compared with the load in plain code: a different rate is flagged,
  // matching dates are confirmed, and nothing on the load changed.
  const checks = reading.getByRole("list", {
    name: "Compared with Relay's records",
  });
  await expect(checks).toContainText(
    "The file says $2,600.00; the load's agreed rate is $2,500.00.",
  );
  await expect(checks).toContainText("The pickup date matches the load.");
  await expect(dialog).toContainText("$2,500.00");

  const axe = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
  await page.addScriptTag({ path: axe });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            c: Document,
            o: object,
          ) => Promise<{ violations: { id: string }[] }>;
        };
      }
    ).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return result.violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);

  await reading.getByRole("button", { name: "I checked these" }).click();
  await expect(reading).toContainText("Checked by Alex Morgan");
  await reading.getByRole("button", { name: "Dismiss" }).click();
  await expect(
    rate.getByRole("button", { name: "Read with AI" }),
  ).toBeVisible();
});

test("documents: upload a BOL, accept it, and see versioned status on the load", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "DOC");
  const dialog = await openLoad(page, load.reference);
  const bol = dialog.getByRole("article", { name: "Bill of lading" });
  await expect(bol.locator(".docStatus")).toHaveText("Missing");
  await bol.getByLabel("Upload file").setInputFiles(pdf("bol-scan"));
  await bol.getByRole("button", { name: "Upload Bill of lading" }).click();
  await expect(dialog.getByRole("status").first()).toContainText(
    "Bill of lading uploaded for review.",
  );
  await expect(bol.locator(".docStatus")).toHaveText("Awaiting review");
  await expect(bol).toContainText("v1 · bol-scan.pdf");
  await bol.getByRole("button", { name: "Reject" }).click();
  await bol.getByLabel("Reason for rejection").fill("Unsigned by receiver");
  await bol.getByRole("button", { name: "Reject file" }).click();
  await expect(bol.locator(".docStatus")).toHaveText("Rejected");
  await bol.getByLabel("Upload new version").setInputFiles(pdf("bol-signed"));
  await bol.getByRole("button", { name: "Upload Bill of lading" }).click();
  await expect(bol).toContainText("v2 · bol-signed.pdf");
  await bol.getByRole("button", { name: "Accept" }).click();
  await expect(bol.locator(".docStatus")).toHaveText("Accepted");
  await bol.getByText("Earlier versions (1)").click();
  await expect(bol).toContainText("Unsigned by receiver");
  const download = bol.getByRole("link", {
    name: "Download bol-signed.pdf version 2",
  });
  const href = await download.getAttribute("href");
  const file = await page.request.get(href!);
  expect(file.headers()["content-disposition"]).toContain("attachment");
  expect((await file.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await expect(
    dialog.locator(".event").filter({ hasText: "Document reviewed" }),
  ).toHaveCount(2);
});

test("exceptions: flag with owner from a suggestion, work it from the queue and resolve", async ({
  page,
}) => {
  await login(page);
  const { carrier, driver } = await blueRidge(page);
  const load = await createLoad(page, carrier, "EXC");
  const assigned = await page.request.post(`/api/loads/${load.id}/assign`, {
    headers: origin,
    data: { version: 1, driverId: driver },
  });
  const dispatched = await page.request.post(
    `/api/loads/${load.id}/milestones`,
    {
      headers: origin,
      data: { version: (await assigned.json()).version, stage: "dispatched" },
    },
  );
  expect(dispatched.status()).toBe(200);
  const dialog = await openLoad(page, load.reference);
  const suggestions = dialog.getByLabel("Suggested exceptions");
  await expect(suggestions).toContainText("Rate confirmation is missing");
  await suggestions.getByRole("button", { name: "Flag this" }).click();
  const form = dialog.getByRole("form", { name: "Flag exception" });
  await expect(form.getByLabel("Summary")).toHaveValue(
    "Rate confirmation is missing",
  );
  await form.getByLabel("Owner").selectOption({ label: "Alex Morgan" });
  await form.getByRole("button", { name: "Flag exception" }).click();
  const card = dialog.getByRole("article", {
    name: "Missing document exception: Rate confirmation is missing",
  });
  await expect(card).toContainText("Owner Alex Morgan");
  await expect(suggestions).toHaveCount(0);
  await page.getByRole("button", { name: "Close load details" }).click();

  await page.getByRole("button", { name: "Exceptions", exact: true }).click();
  await page.getByLabel("Owner").selectOption("me");
  const row = page.getByRole("button", {
    name: `Open load ${load.reference} for exception Rate confirmation is missing`,
  });
  await expect(row).toBeVisible();
  await row.click();
  const again = page.getByRole("dialog", { name: "Load details" });
  const item = again.getByRole("article", {
    name: "Missing document exception: Rate confirmation is missing",
  });
  await item.getByRole("button", { name: "Start work" }).click();
  await expect(item).toContainText("In progress");
  await item.getByRole("button", { name: "Resolve" }).click();
  await item
    .getByLabel("How was it resolved?")
    .fill("Broker resent the rate con");
  await item.getByRole("button", { name: "Resolve exception" }).click();
  await expect(item).toContainText("Resolved by Alex Morgan");
  await expect(
    again.locator(".event").filter({ hasText: "Exception resolved" }),
  ).toHaveCount(1);
});

test("billing: carrier packet and Relay dispatch invoice stay separate", async ({
  page,
}) => {
  await login(page);
  const { carrier, driver } = await blueRidge(page);
  const load = await createLoad(page, carrier, "BILL");
  let version = (
    await (
      await page.request.post(`/api/loads/${load.id}/assign`, {
        headers: origin,
        data: { version: 1, driverId: driver },
      })
    ).json()
  ).version;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    version = (
      await (
        await page.request.post(`/api/loads/${load.id}/milestones`, {
          headers: origin,
          data: { version, stage },
        })
      ).json()
    ).version;
  for (const type of ["rate_confirmation", "bol", "pod"]) {
    const uploaded = await page.request.post("/api/documents", {
      headers: origin,
      multipart: {
        carrier_id: carrier,
        load_id: load.id,
        type,
        idempotency_key: randomUUID(),
        file: pdf(type),
      },
    });
    expect(uploaded.status()).toBe(201);
    const { version_id } = await uploaded.json();
    expect(
      (
        await page.request.post(`/api/documents/${version_id}/review`, {
          headers: origin,
          data: { decision: "accepted" },
        })
      ).status(),
    ).toBe(200);
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  await page.getByRole("tab", { name: /^Carrier freight/ }).click();
  await page
    .getByRole("button", { name: `Open freight billing for ${load.reference}` })
    .click();
  const sheet = page.getByRole("dialog", { name: "Freight billing" });
  const packet = sheet.getByRole("article", {
    name: `Freight billing for ${load.reference}`,
  });
  await expect(packet).toContainText("Paperwork accepted");
  await packet.getByRole("button", { name: "Prepare packet" }).click();
  await packet
    .getByLabel("Bill to (broker or shipper)")
    .fill("Fictional Broker LLC");
  await packet
    .getByLabel("Carrier invoice number")
    .fill("BR-" + load.reference);
  await expect(packet.getByLabel("Amount (USD)")).toHaveValue("2500.00");
  await packet.getByRole("button", { name: "Save packet" }).click();
  await packet.getByRole("button", { name: "Mark submitted" }).click();
  await expect(packet).toContainText("Packet submitted");
  await packet.getByRole("button", { name: "Record carrier receipt" }).click();
  await packet.getByLabel("Amount received (USD)").fill("2500");
  await packet.getByRole("button", { name: "Record receipt" }).click();
  await expect(
    packet.locator(".opsPill").filter({ hasText: "Paid" }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.getByRole("tab", { name: /^Invoices/ }).click();
  await page.getByRole("button", { name: "New invoice" }).first().click();
  const create = page.getByRole("form", { name: "Create dispatch invoice" });
  await create.getByLabel(`${load.reference} · $2,500.00`).check();
  await create.getByLabel("Dispatch fee (%)").fill("8.5");
  await expect(create).toContainText("Invoice total: $212.50");
  await create.getByRole("button", { name: "Create draft invoice" }).click();
  // The new draft is a row in the invoice table; opening it shows its lines.
  await page
    .getByRole("button", { name: "Open invoice draft" })
    .first()
    .click();
  const invoiceSheet = page.getByRole("dialog", { name: "Invoice" });
  const draft = invoiceSheet.getByRole("article", {
    name: "Dispatch invoice Draft invoice",
  });
  await expect(draft).toContainText(`${load.reference}: $212.50 on $2,500.00`);
  await draft.getByRole("button", { name: "Issue invoice" }).click();
  const issued = invoiceSheet.getByRole("article", {
    name: /Dispatch invoice RLY-\d+/,
  });
  await expect(issued).toContainText("Issued");
  await issued.getByRole("button", { name: "Record payment" }).click();
  await issued.getByLabel("Amount (USD)").fill("212.50");
  await issued.getByRole("button", { name: "Record payment" }).click();
  await expect(
    issued.locator(".opsPill").filter({ hasText: "Paid" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // The table and summary now show it as paid.
  await page.getByRole("button", { name: /^Paid\s*\d+$/ }).click();
  await expect(
    page.getByRole("table", { name: "Dispatch invoices" }),
  ).toContainText("Paid");
  // Drivers never see billing.
  await login(page, "driver@relay.test");
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Billing", exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.request.get("/api/billing?carrier_id=" + carrier)).status(),
  ).toBe(404);
});

test("account: enroll two-step verification and sign in with a code", async ({
  page,
}) => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const email = `mfa-${randomUUID().slice(0, 8)}@relay.test`;
  const password = "fictional-mfa-password";
  try {
    const user = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash,name,email_verified_at) VALUES($1,$2,$3,'MFA Browser QA',now())",
      [user, email, await hashNewPassword(password)],
    );
    await db.query(
      "INSERT INTO memberships SELECT $1,id,'carrier-manager',NULL FROM carriers WHERE name='Blue Ridge Transport' LIMIT 1",
      [user],
    );
    await page.goto("/");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page.getByText("Email address")).toBeVisible();
    await page
      .getByRole("button", { name: "Set up two-step verification" })
      .click();
    const secret = (await page.getByLabel("Setup key").textContent())!.replace(
      /\s/g,
      "",
    );
    await page
      .getByLabel("6-digit code from the app")
      .fill(codeAt(secret, stepAt(Date.now())));
    await page.getByRole("button", { name: "Turn on" }).click();
    const codes = page.getByRole("list", { name: "Recovery codes" });
    await expect(codes.getByRole("listitem")).toHaveCount(10);
    const recovery = (await codes.getByRole("listitem").first().textContent())!;
    await page
      .getByRole("button", { name: "I saved my recovery codes" })
      .click();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const challenge = page.getByRole("form", { name: "Two-step verification" });
    await challenge.getByLabel("Authentication code").fill("000000");
    await challenge.getByRole("button", { name: "Verify and sign in" }).click();
    await expect(page.locator(".alert.error")).toContainText("didn't match");
    await challenge.getByLabel("Authentication code").fill(recovery);
    await challenge.getByRole("button", { name: "Verify and sign in" }).click();
    await expect(
      page.getByRole("heading", { name: "All loads" }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});

test("forgot password never reveals whether an account exists", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  const form = page.getByRole("form", { name: "Reset password" });
  await form
    .getByLabel("Account email")
    .fill(`nobody-${randomUUID()}@relay.test`);
  await form.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(form.getByRole("status")).toContainText(
    "If an account uses that email",
  );
  await page.goto("/reset-password#not-a-token");
  await expect(
    page.getByRole("heading", { name: "Link unavailable." }),
  ).toBeVisible();
});

test("demo shows exceptions, billing and notifications without calling the server", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  await page.route("**/api/**", (route) => {
    apiRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/demo");
  await page.getByRole("button", { name: "Exceptions", exact: true }).click();
  await expect(
    page.getByText("Driver reports a two-hour weather delay"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: /^Carrier freight/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Billing summary" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await expect(
    page.getByText("Demo — nothing is sent from this device"),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("multi-stop: add an intermediate stop and see every stop in order", async ({
  page,
}) => {
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New load" }).first().click();
  const modal = page.getByRole("dialog", { name: "Create load" });
  const reference = "MS-UI-" + randomUUID().slice(0, 8);
  await modal.getByLabel("Load reference").fill(reference);
  await modal.getByLabel("Agreed rate (USD)").fill("4100");
  await modal
    .getByLabel("Booking source / rate confirmation reference")
    .fill("Fictional multi-stop browser QA");
  await modal
    .getByRole("button", { name: "Add stop before final delivery" })
    .click();
  const fill = async (name: string, address: string, time: string) => {
    const group = modal.getByRole("group", { name, exact: true });
    await group.getByLabel("Address").fill(address);
    await group.getByLabel("Appointment").fill(time);
  };
  await fill("pickup", "Chicago, IL", "2026-11-20T08:00");
  await modal
    .getByRole("group", { name: "Stop 2", exact: true })
    .getByLabel("Stop type")
    .selectOption("delivery");
  await fill("Stop 2", "Indianapolis, IN", "2026-11-20T13:00");
  await fill("delivery", "Louisville, KY", "2026-11-20T18:00");
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal).not.toBeVisible();
  await page.getByRole("textbox", { name: "Search loads" }).fill(reference);
  const card = page.getByRole("button", { name: new RegExp("^" + reference) });
  await expect(card).toContainText("Louisville, KY · 3 stops");
  await card.click();
  const dialog = page.getByRole("dialog", { name: "Load details" });
  await expect(dialog.locator(".stop")).toHaveCount(3);
  await expect(dialog.locator(".stop").nth(1)).toContainText(
    "Indianapolis, IN",
  );
});

test("check-ins can be corrected and retracted while the original stays on record", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "AMEND");
  const report = await page.request.post(`/api/loads/${load.id}/check-ins`, {
    headers: origin,
    data: {
      version: 1,
      location: "Jolliet, IL",
      note: "",
      observed_at: new Date(Date.now() - 20 * 60000).toISOString(),
      idempotency_key: randomUUID(),
    },
  });
  expect(report.status()).toBe(201);
  const dialog = await openLoad(page, load.reference);
  await dialog
    .getByRole("button", { name: "Correct check-in at Jolliet, IL" })
    .click();
  const form = dialog.getByRole("form", { name: "Correct check-in" });
  await form.getByLabel("Corrected location").fill("Joliet, IL");
  await form.getByLabel("Reason").fill("City misspelled");
  await form.getByRole("button", { name: "Save correction" }).click();
  const corrected = dialog.getByRole("article", {
    name: "Check-in: Joliet, IL",
  });
  await expect(corrected).toContainText("Corrected");
  await expect(corrected).toContainText("Originally reported as Jolliet, IL");
  await expect(corrected).toContainText("City misspelled");
  await dialog
    .getByRole("button", { name: "Retract check-in at Joliet, IL" })
    .click();
  const retract = dialog.getByRole("form", { name: "Retract check-in" });
  await retract.getByLabel("Reason").fill("Reported on the wrong load");
  await retract.getByRole("button", { name: "Retract report" }).click();
  await expect(dialog.getByText("Retracted check-ins (1)")).toBeVisible();
  await expect(
    dialog.locator(".event").filter({ hasText: "Check-in retracted" }),
  ).toHaveCount(1);
});

test("older activity loads on demand without duplicates", async ({ page }) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "HIST");
  let version = 1;
  for (let i = 0; i < 105; i++) {
    const r = await page.request.post(`/api/loads/${load.id}/check-ins`, {
      headers: origin,
      data: {
        version,
        location: "Mile " + i,
        note: "",
        observed_at: new Date(Date.now() - (300 - i) * 60000).toISOString(),
        idempotency_key: randomUUID(),
      },
    });
    version = (await r.json()).version;
  }
  const dialog = await openLoad(page, load.reference);
  await expect(dialog.locator(".event")).toHaveCount(100);
  await dialog.getByRole("button", { name: "Show older activity" }).click();
  await expect(dialog.locator(".event")).toHaveCount(106);
  await expect(
    dialog.getByRole("button", { name: "Show older activity" }),
  ).toHaveCount(0);
  await expect(dialog.locator(".event").first()).toContainText("Load created");
  await dialog.getByText(/Previous check-ins/).click();
  // 105 reports: the newest 50, then two older pages (50 and 5).
  const more = dialog.getByRole("button", { name: "Show older check-ins" });
  await more.click();
  await expect(
    dialog.getByRole("article", { name: "Check-in: Mile 5", exact: true }),
  ).toBeVisible();
  await more.click();
  await expect(more).toHaveCount(0);
  await expect(
    dialog.getByRole("article", { name: "Check-in: Mile 0", exact: true }),
  ).toBeVisible();
});

test("stops: record arrival and departure, then correct a time with a reason", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "STOP");
  const dialog = await openLoad(page, load.reference);
  const first = dialog.getByRole("article", { name: "Stop 1: Chicago, IL" });
  await first.getByRole("button", { name: "Record arrival at stop 1" }).click();
  const arrival = first.getByRole("form", { name: "Arrived time for stop 1" });
  await arrival
    .getByLabel(/Arrived time/)
    .fill(
      new Date(Date.now() - 3 * 3600000 - 6 * 3600000)
        .toISOString()
        .slice(0, 16),
    );
  await arrival.getByRole("button", { name: "Save arrived time" }).click();
  await expect(first.locator(".stopTimes")).toContainText("Arrived");
  await first
    .getByRole("button", { name: "Record departure from stop 1" })
    .click();
  const departure = first.getByRole("form", {
    name: "Departed time for stop 1",
  });
  await departure.getByRole("button", { name: "Save departed time" }).click();
  await expect(first.locator(".stopTimes")).toContainText("on site");
  await expect(first.locator(".stopTimes")).toContainText("check detention");
  await first
    .getByRole("button", { name: "Correct arrival at stop 1" })
    .click();
  const fix = first.getByRole("form", { name: "Arrived time for stop 1" });
  await fix
    .getByLabel(/Arrived time/)
    .fill(
      new Date(Date.now() - 7 * 3600000 - 30 * 60000)
        .toISOString()
        .slice(0, 16),
    );
  await fix.getByLabel("Reason for correction").fill("Gate time, not dock");
  await fix.getByRole("button", { name: "Save correction" }).click();
  await first.getByText("Time history (3)").click();
  await expect(first).toContainText("corrected: Gate time, not dock");
  await expect(
    dialog.locator(".event").filter({ hasText: "Stop arrival corrected" }),
  ).toHaveCount(1);
  await expect(dialog.locator(".badge")).toHaveText("Booked");
});

test("files over 4 MB upload directly to the bucket and retry with the same key", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "BIG");
  const requests: string[] = [];
  const sessionBodies: {
    idempotency_key: string;
    sha256: string;
    size_bytes: number;
  }[] = [];
  let putAttempts = 0;
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/documents"))
      requests.push(r.method() + " " + url.pathname);
  });
  await page.route("**/api/documents/uploads", (route) => {
    sessionBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: {
        status: "pending",
        session_id: "11111111-1111-4111-8111-111111111111",
        upload_url:
          "https://bucket.example.test/relay-docs/quarantine/x?X-Amz-Signature=fake",
        upload_headers: { "Content-Type": "application/octet-stream" },
      },
    });
  });
  await page.route("https://bucket.example.test/**", (route) => {
    putAttempts++;
    return putAttempts === 1
      ? route.abort("connectionreset")
      : route.fulfill({ status: 200, body: "" });
  });
  await page.route("**/api/documents/uploads/*/finalize", (route) =>
    route.fulfill({
      status: 201,
      json: { document_id: randomUUID(), version_id: randomUUID(), version: 1 },
    }),
  );
  const dialog = await openLoad(page, load.reference);
  const pod = dialog.getByRole("article", { name: "Proof of delivery" });
  await pod.getByLabel("Upload file").setInputFiles({
    name: "big-pod.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(5 * 1024 * 1024, 0x20),
    ]),
  });
  await pod.getByRole("button", { name: "Upload Proof of delivery" }).click();
  await expect(pod.getByRole("alert")).toContainText(
    "didn't make it to storage",
  );
  await pod.getByRole("button", { name: "Upload Proof of delivery" }).click();
  await expect(dialog.getByRole("status").first()).toContainText(
    "Proof of delivery uploaded for review.",
  );
  expect(putAttempts).toBe(2);
  // The large body never went through the app server's upload endpoint.
  expect(requests).not.toContain("POST /api/documents");
  expect(
    requests.filter((r) => r === "POST /api/documents/uploads"),
  ).toHaveLength(2);
  expect(sessionBodies[0].idempotency_key).toBe(
    sessionBodies[1].idempotency_key,
  );
  expect(sessionBodies[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(sessionBodies[0].size_bytes).toBe(5 * 1024 * 1024 + 9);
});

test("an owner invites a dispatcher, who joins from the private link and sees only chosen carriers", async ({
  page,
  browser,
}) => {
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Organization", exact: true }).click();
  const email = `dispatcher-${randomUUID().slice(0, 8)}@relay.test`;
  const card = page.getByRole("article", { name: "Team invitations" });
  await card.getByRole("button", { name: "Invite", exact: true }).click();
  const form = card.getByRole("form", { name: "Invite teammate" });
  await form.getByLabel("Name").fill("Taylor Dispatch");
  await form.getByLabel("Email").fill(email);
  const boxes = form.getByRole("checkbox");
  for (let i = (await boxes.count()) - 1; i > 0; i--)
    await boxes.nth(i).uncheck();
  await form.getByRole("button", { name: "Create invitation" }).click();
  const link = await card
    .getByRole("textbox", { name: "Invitation link" })
    .inputValue();
  expect(link).toMatch(/\/join#[a-f0-9]{64}$/);
  await expect(card).toContainText("Taylor Dispatch");
  await expect(card).toContainText("Dispatcher");

  const invitee = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  const joinPage = await invitee.newPage();
  await joinPage.goto(link);
  await expect(joinPage.getByText("invited you as a dispatcher")).toBeVisible();
  await joinPage.getByLabel("Password").fill("fictional-browser-password");
  await joinPage.getByRole("button", { name: "Join workspace" }).click();
  await expect(
    joinPage.getByRole("heading", { name: "Welcome aboard." }),
  ).toBeVisible();
  await joinPage.getByRole("link", { name: "Open workspace" }).click();
  await expect(
    joinPage.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  const me = await (await joinPage.request.get("/api/me")).json();
  expect(me.carriers).toHaveLength(1);
  expect(me.carriers[0].role).toBe("dispatcher");
  expect(
    me.organizations.filter((o: { role?: string }) => o.role),
  ).toHaveLength(0);
  await invitee.close();
  // The used link is gone from the pending list.
  await page.reload();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Organization", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Team invitations" }),
  ).not.toContainText(email);
});

test("contacts: search by phone digits, add a broker, quick actions and favorites", async ({
  page,
}) => {
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  const region = page.getByRole("region", { name: "Contacts" });
  const unique = randomUUID().slice(0, 6);
  await region.getByRole("button", { name: "Add contact" }).click();
  const form = region.getByRole("form", { name: "Add contact" });
  await form.getByLabel("Name").fill("Riley Broker " + unique);
  await form.getByLabel("Company").fill("Browser Test Brokerage");
  await form
    .getByLabel("Phone")
    .fill("(214) 555-0" + String(Math.floor(100 + Math.random() * 899)));
  await form.getByLabel("Email").fill(`riley-${unique}@broker.test`);
  const phone = await form.getByLabel("Phone").inputValue();
  await form.getByRole("button", { name: "Add contact" }).click();
  const row = region.getByRole("article", {
    name: new RegExp("Riley Broker " + unique),
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Browser Test Brokerage · Broker");
  // Quick connect links open on the user's own device.
  const digits = phone.replace(/\D/g, "");
  await expect(row.getByRole("link", { name: /^Call Riley/ })).toHaveAttribute(
    "href",
    "tel:" + digits,
  );
  await expect(row.getByRole("link", { name: /^Text Riley/ })).toHaveAttribute(
    "href",
    "sms:" + digits,
  );
  await expect(row.getByRole("link", { name: /^Email Riley/ })).toHaveAttribute(
    "href",
    `mailto:riley-${unique}@broker.test`,
  );
  // Search finds it by company, by email and by differently formatted digits.
  const search = region.getByRole("searchbox", { name: "Search contacts" });
  for (const term of [
    "Browser Test Brokerage",
    `riley-${unique}`,
    digits.slice(3),
  ]) {
    await search.fill(term);
    await expect(
      region.getByRole("article", {
        name: new RegExp("Riley Broker " + unique),
      }),
    ).toBeVisible();
  }
  await search.fill("zzz-no-such-person");
  await expect(
    region.getByRole("heading", { name: "No matching contacts" }),
  ).toBeVisible();
  await search.fill("");
  // Favorites move to the top and persist.
  await region
    .getByRole("button", {
      name: new RegExp("Add Riley Broker " + unique + " to favorites"),
    })
    .click();
  await expect(
    region.getByText("Favorites", { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  await region.getByLabel("Favorites").check();
  await expect(
    region.getByRole("article", { name: new RegExp("Riley Broker " + unique) }),
  ).toBeVisible();
});

test("a driver can reach dispatch from Contacts but sees no brokers or other drivers", async ({
  page,
}) => {
  await login(page, "driver@relay.test");
  await page.goto("/");
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  const region = page.getByRole("region", { name: "Contacts" });
  await expect(
    region.getByRole("article", { name: /Alex Morgan, Dispatcher/ }),
  ).toBeVisible();
  await expect(region.getByRole("button", { name: "Add contact" })).toHaveCount(
    0,
  );
  await expect(region.getByRole("article", { name: /Broker/ })).toHaveCount(0);
  await expect(region.getByRole("article", { name: /, Driver/ })).toHaveCount(
    0,
  );
});

test("inbox: message a driver from Contacts, driver sees unread and replies, calls can be logged", async ({
  page,
  browser,
}) => {
  const unique = randomUUID().slice(0, 6);
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  const contacts = page.getByRole("region", { name: "Contacts" });
  await contacts.getByRole("searchbox").fill("Jordan");
  await contacts.getByRole("button", { name: /^Message Jordan/ }).click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  const composer = inbox.getByRole("form", { name: "Write a message" });
  await expect(
    composer.getByRole("button", { name: /Remove Jordan/ }),
  ).toBeVisible();
  await composer.getByLabel("Subject").fill("Pickup time " + unique);
  await composer.locator("textarea").fill("Please confirm 8am.");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(
    inbox.getByRole("heading", { name: "Pickup time " + unique }),
  ).toBeVisible();
  await expect(
    inbox.getByText("Jordan Ellis: Delivered in Relay"),
  ).toBeVisible();

  // The driver sees an unread badge, opens the thread and replies.
  const driverContext = await browser.newContext();
  const driverPage = await driverContext.newPage();
  await login(driverPage, "driver@relay.test");
  await driverPage.goto("/");
  await expect(
    driverPage.getByRole("button", { name: /^Inbox/ }),
  ).toContainText("unread");
  await driverPage.getByRole("button", { name: /^Inbox/ }).click();
  const driverInbox = driverPage.getByRole("region", { name: "Inbox" });
  await driverInbox
    .getByRole("button", { name: new RegExp("Pickup time " + unique) })
    .click();
  await expect(
    driverInbox
      .getByRole("list", { name: "Messages" })
      .getByText("Please confirm 8am."),
  ).toBeVisible();
  // Drivers cannot log calls or send email or texts.
  await expect(
    driverInbox.getByRole("option", { name: "Send email" }),
  ).toHaveCount(0);
  await driverInbox.locator("textarea").fill("Confirmed, 8am.");
  await driverInbox.getByRole("button", { name: "Send" }).click();
  await expect(
    driverInbox
      .getByRole("list", { name: "Messages" })
      .getByText("Confirmed, 8am."),
  ).toBeVisible();
  await driverContext.close();

  // Dispatcher sees the reply, searches for it and logs a phone call.
  await page.reload();
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await inbox.getByRole("searchbox").fill("Confirmed, 8am");
  await inbox
    .getByRole("button", { name: new RegExp("Pickup time " + unique) })
    .click();
  await expect(
    inbox.getByRole("list", { name: "Messages" }).getByText("Confirmed, 8am."),
  ).toBeVisible();
  await inbox.getByLabel("Action").selectOption({ label: "Log call I made" });
  await inbox.getByLabel("Notes").fill("Called Jordan; on the way.");
  await inbox.getByRole("button", { name: "Save to log" }).click();
  await expect(
    inbox
      .getByRole("list", { name: "Messages" })
      .getByText("Call · logged by hand"),
  ).toBeVisible();
});

test("inbox: saved replies fill in names and can be inserted", async ({
  page,
}) => {
  const unique = randomUUID().slice(0, 6);
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Inbox/ }).click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  await inbox.getByRole("button", { name: "New message" }).click();
  await inbox.getByRole("button", { name: "Manage replies" }).click();
  const replies = inbox.getByRole("region", { name: "Saved replies" });
  await replies.getByRole("button", { name: "New reply" }).click();
  await replies.getByLabel("Title").fill("ETA " + unique);
  await replies
    .getByLabel("Text")
    .fill("Hi {name}, what is your ETA? — {sender}");
  await replies.getByRole("button", { name: "Save reply" }).click();
  await expect(replies.getByText("ETA " + unique)).toBeVisible();
  await replies.getByRole("button", { name: "Close" }).click();
  const composer = inbox.getByRole("form", { name: "Write a message" });
  await composer.getByRole("searchbox", { name: "Find people" }).fill("Jordan");
  await composer.getByRole("button", { name: /^Add Jordan/ }).click();
  await composer
    .getByLabel("Saved reply")
    .selectOption({ label: "ETA " + unique });
  await expect(composer.locator("textarea")).toHaveValue(
    /^Hi Jordan, what is your ETA\? — .+/,
  );
});

test("loads: fix an address with history, then cancel with a reason", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "EDIT");
  const dialog = await openLoad(page, load.reference);
  await dialog.getByRole("button", { name: "Edit load" }).click();
  const edit = page.getByRole("dialog", { name: "Edit load" });
  await edit.getByLabel("Address").first().fill("Chicago, IL 60601 (Dock 4)");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(
    dialog.getByText("Chicago, IL 60601 (Dock 4)").first(),
  ).toBeVisible();
  await dialog.getByText(/Change history/).click();
  await expect(dialog.locator(".changeLog")).toContainText(
    "Chicago, IL → Chicago, IL 60601 (Dock 4)",
  );
  await dialog.getByRole("button", { name: "Cancel load" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel load" });
  await cancel.getByLabel("Reason").fill("Broker withdrew");
  await cancel.getByRole("button", { name: "Cancel this load" }).click();
  await expect(dialog.getByText("Broker withdrew")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Edit load" })).toHaveCount(
    0,
  );
});

test("loads: a cancel whose response is lost can be retried safely", async ({
  page,
}) => {
  await login(page);
  const { carrier } = await blueRidge(page);
  const load = await createLoad(page, carrier, "RETRY");
  const dialog = await openLoad(page, load.reference);
  let attempts = 0;
  const keys: (string | undefined)[] = [];
  await page.route("**/api/loads/*/cancel", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (++attempts === 1) {
      // The server applies the cancel, but the browser never sees the reply.
      await route.fetch();
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await dialog.getByRole("button", { name: "Cancel load" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel load" });
  await cancel.getByLabel("Reason").fill("Customer closed the dock");
  await cancel.getByRole("button", { name: "Cancel this load" }).click();
  await expect(cancel.getByRole("alert")).toBeVisible();
  await cancel.getByRole("button", { name: "Cancel this load" }).click();
  await expect(dialog.getByText("Customer closed the dock")).toBeVisible();
  expect(attempts).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test("inbox: attach a PDF to a message and download it as the recipient", async ({
  page,
  browser,
}) => {
  const unique = randomUUID().slice(0, 6);
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Inbox/ }).click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  await inbox.getByRole("button", { name: "New message" }).click();
  const composer = inbox.getByRole("form", { name: "Write a message" });
  await composer.getByRole("searchbox", { name: "Find people" }).fill("Jordan");
  await composer.getByRole("button", { name: /^Add Jordan/ }).click();
  await composer.getByLabel("Subject").fill("Docs " + unique);
  await composer.locator("textarea").fill("Rate con attached.");
  await composer
    .locator('input[type="file"]')
    .setInputFiles(pdf("ratecon" + unique));
  await expect(
    composer.getByRole("button", { name: /Remove ratecon/ }),
  ).toBeVisible();
  // Email and text cannot carry files, so the control goes away.
  await composer.getByLabel("Action").selectOption({ label: "Send email" });
  await expect(composer.locator('input[type="file"]')).toHaveCount(0);
  await composer
    .getByLabel("Action")
    .selectOption({ label: "Message in Relay" });
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(
    inbox
      .getByRole("list", { name: "Attachments" })
      .getByRole("link", { name: "ratecon" + unique + ".pdf" }),
  ).toBeVisible();
  const other = await browser.newContext();
  const driverPage = await other.newPage();
  await login(driverPage, "driver@relay.test");
  await driverPage.goto("/");
  await driverPage.getByRole("button", { name: /^Inbox/ }).click();
  const driverInbox = driverPage.getByRole("region", { name: "Inbox" });
  await driverInbox
    .getByRole("button", { name: new RegExp("Docs " + unique) })
    .click();
  const href = await driverInbox
    .getByRole("link", { name: "ratecon" + unique + ".pdf" })
    .getAttribute("href");
  const download = await driverPage.request.get(href!);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toBe("application/pdf");
  await other.close();
});

test("reports: KPIs for a carrier, range presets and CSV export link", async ({
  page,
}) => {
  await login(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const region = page.getByRole("region", { name: "Reports" });
  await expect(region.getByText("Freight value")).toBeVisible();
  await expect(region.getByRole("table").first()).toBeVisible();
  await region.getByRole("button", { name: "Last 7 days" }).click();
  await expect(region.getByText("Report loaded")).toBeAttached();
  const href = await region
    .getByRole("link", { name: /Export loads/ })
    .getAttribute("href");
  expect(href).toContain("/api/reports/loads.csv?from=");
  const csv = await page.request.get(href!);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toMatch(/^Reference,Carrier,Status/);
});

test("a driver has no Reports page and the API refuses them", async ({
  page,
}) => {
  await login(page, "driver@relay.test");
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Reports", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/api/reports")).status()).toBe(404);
});

test("friction: message a load's driver in two clicks, no subject needed, Ctrl+Enter sends", async ({
  page,
}) => {
  const unique = randomUUID().slice(0, 6);
  await login(page);
  const { carrier, driver } = await blueRidge(page);
  const load = await createLoad(page, carrier, "EASY");
  const assigned = await page.request.post(`/api/loads/${load.id}/assign`, {
    headers: origin,
    data: { version: load.version, driverId: driver },
  });
  expect(assigned.status()).toBe(200);
  const dialog = await openLoad(page, load.reference);
  await dialog.getByRole("button", { name: "Message about this load" }).click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  const composer = inbox.getByRole("form", { name: "Write a message" });
  // The driver is already chosen for us.
  await expect(
    composer.getByRole("button", { name: /Remove Jordan/ }),
  ).toBeVisible();
  const text = composer.locator("textarea");
  await text.fill("Quick one " + unique);
  await text.press("Control+Enter");
  await expect(
    inbox.getByRole("heading", { name: "About " + load.reference }),
  ).toBeVisible();
  await expect(inbox.getByText("Message sent.")).toBeAttached();
});

test("friendly wording: wrong password and the show-password option", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("dispatcher@relay.test");
  await page.getByLabel("Password", { exact: true }).fill("not-the-password-1");
  await page.getByLabel("Show password").check();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".alert.error")).toContainText("don't match");
});
