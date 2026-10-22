import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ensureVolume, invoiceFor } from "./volume";

/** Every load, invoice and carrier has its own address (ADR 0045). */
async function login(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(response.status()).toBe(200);
}
async function ids(page: Page) {
  const me = await (await page.request.get("/api/me")).json();
  const carrier = (name: string) =>
    me.carriers.find((c: { name: string }) => c.name === name).id as string;
  const loads = await (await page.request.get("/api/loads")).json();
  return {
    blueRidge: carrier("Blue Ridge Transport"),
    prairie: carrier("Prairie Line Logistics"),
    load: loads.loads[0] as { id: string; reference: string },
  };
}
const path = (page: Page) => new URL(page.url()).pathname;

test("a load opens at its own address and survives reload, Back and Forward", async ({
  page,
}) => {
  await login(page);
  const { load } = await ids(page);
  await page.goto(`/loads/${load.id}`);
  const dialog = page.getByRole("dialog", { name: "Load details" });
  await expect(dialog).toContainText(load.reference);
  expect(path(page)).toBe(`/loads/${load.id}`);
  await expect(page).toHaveTitle(`Load ${load.reference} · Relay`);
  await page.reload();
  await expect(dialog).toContainText(load.reference);
  // Closing returns to the list's address; Back reopens; Forward closes.
  await dialog.getByRole("button", { name: "Close load details" }).click();
  await expect(dialog).toHaveCount(0);
  expect(path(page)).toBe("/");
  await page.goBack();
  await expect(dialog).toContainText(load.reference);
  expect(path(page)).toBe(`/loads/${load.id}`);
  await page.goForward();
  await expect(dialog).toHaveCount(0);
  expect(path(page)).toBe("/");
});

test("opening a load from the list gives it an address", async ({ page }) => {
  await login(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: /^(?!Open )[A-Z0-9-]{3,}/ })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Load details" }),
  ).toBeVisible();
  expect(path(page)).toMatch(/^\/loads\/[0-9a-f-]{36}$/);
});

test("each page has its address and the sidebar follows it", async ({
  page,
}) => {
  await login(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await nav.getByRole("button", { name: "Billing", exact: true }).click();
  expect(path(page)).toBe("/billing");
  await nav.getByRole("button", { name: "Carriers", exact: true }).click();
  expect(path(page)).toBe("/carriers");
  await page.goBack();
  expect(path(page)).toBe("/billing");
  await expect(
    page.getByRole("region", { name: "Billing and payments" }),
  ).toBeVisible();
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeAttached();
  await expect(page).toHaveTitle("Reports · Relay");
});

test("an invoice opens at its own address, even on another carrier", async ({
  page,
}) => {
  await ensureVolume();
  const prairieInvoice = await invoiceFor("Prairie Line Logistics");
  await login(page);
  await page.goto(`/billing/invoices/${prairieInvoice}`);
  const sheet = page.getByRole("dialog", { name: "Invoice" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("LINK-");
  expect(path(page)).toBe(`/billing/invoices/${prairieInvoice}`);
  // The page switched to that invoice's carrier.
  await expect(page.getByLabel("Carrier")).toHaveValue(/.+/);
  await sheet.getByRole("button", { name: /Close/ }).first().click();
  await expect(sheet).toHaveCount(0);
  expect(path(page)).toBe("/billing");
  await page.goBack();
  await expect(sheet).toBeVisible();
});

test("a carrier opens at its own address for setup and for documents", async ({
  page,
}) => {
  await login(page);
  const { blueRidge } = await ids(page);
  await page.goto(`/carriers/${blueRidge}`);
  const setup = page.getByRole("dialog", { name: "Carrier setup" });
  await expect(setup).toBeVisible();
  await page.getByRole("button", { name: "Close carrier setup" }).click();
  await expect(setup).toHaveCount(0);
  expect(path(page)).toBe("/carriers");
  await page.goto(`/carriers/${blueRidge}/documents`);
  const docs = page.getByRole("dialog", { name: "Carrier documents" });
  await expect(docs).toBeVisible();
  await page.getByRole("button", { name: "Close carrier documents" }).click();
  expect(path(page)).toBe("/carriers");
});

test("a link opened while signed out lands on the record after sign-in", async ({
  page,
}) => {
  await login(page);
  const { load } = await ids(page);
  await page.context().clearCookies();
  await page.goto(`/loads/${load.id}`);
  await page.getByLabel("Email", { exact: true }).fill("dispatcher@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("dialog", { name: "Load details" }),
  ).toContainText(load.reference);
  expect(path(page)).toBe(`/loads/${load.id}`);
});

test("a load that does not exist and one that is not yours read the same", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/loads/${randomUUID()}`);
  await expect(page.locator(".alert.error")).toContainText(
    /couldn.t find that/,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => path(page)).toBe("/");
  // A real load of a carrier the carrier manager has no part in.
  const { prairie } = await ids(page);
  const created = await page.request.post("/api/loads", {
    headers: {
      Origin: "http://localhost:3000",
      "Idempotency-Key": randomUUID(),
    },
    data: {
      carrierId: prairie,
      reference: "LINK-" + randomUUID().slice(0, 8),
      source: "Fictional link QA",
      amountMinor: 50000,
      stops: [
        {
          kind: "pickup",
          address: "Tulsa, OK",
          timezone: "America/Chicago",
          windowStart: "2026-11-05T15:00:00Z",
          windowEnd: "2026-11-05T16:00:00Z",
        },
        {
          kind: "delivery",
          address: "Omaha, NE",
          timezone: "America/Chicago",
          windowStart: "2026-11-06T15:00:00Z",
          windowEnd: "2026-11-06T16:00:00Z",
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const foreign = (await created.json()).id as string;
  await page.context().clearCookies();
  await login(page, "carrier@relay.test");
  expect((await page.request.get(`/api/loads/${foreign}`)).status()).toBe(404);
  await page.goto(`/loads/${foreign}`);
  await expect(page.locator(".alert.error")).toContainText(
    /couldn.t find that/,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a driver is sent to Loads from pages and carriers they may not open", async ({
  page,
}) => {
  await login(page, "driver@relay.test");
  await page.goto("/billing");
  await expect(page.locator(".alert.error")).toContainText(
    /couldn.t find that/,
  );
  await expect.poll(() => path(page)).toBe("/");
  const me = await (await page.request.get("/api/me")).json();
  await page.goto(`/carriers/${me.carriers[0].id}`);
  await expect(page.locator(".alert.error")).toContainText(
    /couldn.t find that/,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("addresses that name nothing are 404s", async ({ page }) => {
  for (const bad of [
    "/loads/not-a-uuid",
    "/billing/invoices",
    "/carriers/x/documents",
    "/nope",
  ]) {
    const response = await page.goto(bad);
    expect(response!.status(), bad).toBe(404);
  }
  // Static pages are not swallowed by the workspace route.
  expect((await page.goto("/pricing"))!.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/./);
});
