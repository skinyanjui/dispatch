import { randomUUID } from "node:crypto";
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

  await page.getByRole("button", { name: "Exception queue" }).click();
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
  await page.getByRole("button", { name: "Billing and payments" }).click();
  const packet = page.getByRole("article", {
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

  const create = page.getByRole("form", { name: "Create dispatch invoice" });
  await create.getByLabel(`${load.reference} · $2,500.00`).check();
  await create.getByLabel("Dispatch fee (%)").fill("8.5");
  await expect(create).toContainText("Invoice total: $212.50");
  await create.getByRole("button", { name: "Create draft invoice" }).click();
  const draft = page
    .getByRole("article", { name: "Dispatch invoice Draft invoice" })
    .first();
  await expect(draft).toContainText(`${load.reference}: $212.50 on $2,500.00`);
  await draft.getByRole("button", { name: "Issue invoice" }).click();
  const issued = page
    .getByRole("article", { name: /Dispatch invoice RLY-\d+/ })
    .filter({ hasText: load.reference });
  await expect(issued).toContainText("Issued");
  await issued.getByRole("button", { name: "Record payment" }).click();
  await issued.getByLabel("Amount (USD)").fill("212.50");
  await issued.getByRole("button", { name: "Record payment" }).click();
  await expect(
    issued.locator(".opsPill").filter({ hasText: "Paid" }),
  ).toBeVisible();
  // Drivers never see billing.
  await login(page, "driver@relay.test");
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Billing and payments" }),
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
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
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
    await page.getByRole("button", { name: "Sign out" }).first().click();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
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
  await page.getByRole("button", { name: "Exception queue" }).click();
  await expect(
    page.getByText("Driver reports a two-hour weather delay"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Billing and payments" }).click();
  await expect(
    page.getByRole("heading", { name: "Carrier freight billing" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Demo — nothing is sent from this device"),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
});
