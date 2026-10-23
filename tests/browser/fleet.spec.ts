import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, email = "dispatcher@relay.test") {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(response.status()).toBe(200);
}
const path = (page: Page) => new URL(page.url()).pathname;
const unit = () => "Unit " + randomUUID().slice(0, 6);

async function addVehicle(page: Page, label: string, plate = "") {
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add vehicle" });
  await sheet.getByLabel("Unit name").fill(label);
  if (plate) await sheet.getByLabel("Plate (optional)").fill(plate);
  await sheet.getByRole("button", { name: "Add vehicle", exact: true }).click();
  return sheet;
}

test("a dispatcher manages vehicles: add, reject a duplicate, edit, retire, reactivate", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Fleet", exact: true })
    .click();
  expect(path(page)).toBe("/fleet");
  await expect(page).toHaveTitle("Fleet · Relay");
  // Drivers come from carrier setup and are listed here.
  const drivers = page.getByRole("table", { name: "Drivers" });
  await expect(drivers).toContainText("Jordan Ellis");
  // Add.
  const label = unit();
  const sheet = await addVehicle(page, label, "ab 1234");
  await expect(sheet).toHaveCount(0);
  const vehicles = page.getByRole("table", { name: "Vehicles" });
  const row = vehicles.getByRole("row", { name: new RegExp(label) });
  await expect(row).toContainText("AB 1234");
  await expect(row).toContainText("In service");
  await expect(page.getByRole("status")).toContainText(`${label} added`);
  // The same name again is refused, in plain words, and keeps the form open.
  const again = await addVehicle(page, label.toUpperCase());
  await expect(again.getByRole("alert")).toContainText(/already has a vehicle/);
  await again.getByRole("button", { name: "Cancel" }).click();
  // An invalid VIN is stopped before it is sent.
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const bad = page.getByRole("dialog", { name: "Add vehicle" });
  await bad.getByLabel("Unit name").fill(unit());
  await bad.getByLabel("VIN (optional)").fill("TOOSHORT");
  await bad.getByRole("button", { name: "Add vehicle", exact: true }).click();
  await expect(bad).toBeVisible();
  await bad.getByRole("button", { name: "Cancel" }).click();
  // Edit.
  await row.getByRole("button", { name: /^Edit/ }).click();
  const edit = page.getByRole("dialog", { name: "Edit vehicle" });
  await edit.getByLabel("Type").selectOption("cargo_van");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Cargo van");
  // Retire asks first, then hides it behind "Show retired".
  await row.getByRole("button", { name: /^Retire/ }).click();
  const confirm = page.getByRole("dialog", { name: "Retire vehicle" });
  await expect(confirm).toContainText("can’t be chosen for new loads");
  await confirm
    .getByRole("button", { name: "Retire vehicle", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await page.getByLabel(/Show retired/).check();
  await expect(row).toContainText("Retired");
  await row.getByRole("button", { name: /^Reactivate/ }).click();
  await expect(row).toContainText("In service");
  // The sidebar search narrows both tables.
  await page.getByRole("searchbox", { name: "Search the fleet" }).fill(label);
  await expect(vehicles.getByRole("row")).toHaveCount(2); // header + the one unit
  await expect(
    page.getByRole("heading", { name: "No drivers match" }),
  ).toBeVisible();
});

test("a vehicle can be chosen when a driver is assigned, and is shown on the load", async ({
  page,
}) => {
  await login(page);
  const me = await (await page.request.get("/api/me")).json();
  const carrier = me.carriers.find(
    (c: { name: string }) => c.name === "Blue Ridge Transport",
  ).id;
  const label = unit();
  const made = await page.request.post("/api/fleet/vehicles", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      carrier_id: carrier,
      label,
      kind: "tractor",
      plate: "",
      vin: "",
      key: randomUUID(),
    },
  });
  expect(made.status()).toBe(201);
  const created = await page.request.post("/api/loads", {
    headers: {
      Origin: "http://localhost:3000",
      "Idempotency-Key": randomUUID(),
    },
    data: {
      carrierId: carrier,
      reference: "FLEET-" + randomUUID().slice(0, 6),
      source: "Fictional fleet QA",
      amountMinor: 90000,
      stops: [
        {
          kind: "pickup",
          address: "Gary, IN",
          timezone: "America/Chicago",
          windowStart: "2026-11-05T15:00:00Z",
          windowEnd: "2026-11-05T16:00:00Z",
        },
        {
          kind: "delivery",
          address: "Dayton, OH",
          timezone: "America/New_York",
          windowStart: "2026-11-06T15:00:00Z",
          windowEnd: "2026-11-06T16:00:00Z",
        },
      ],
    },
  });
  const load = await created.json();
  await page.goto(`/loads/${load.id}`);
  const dialog = page.getByRole("dialog", { name: "Load details" });
  const form = dialog.locator(".assignForm");
  await form
    .getByRole("combobox", { name: "Authorized driver" })
    .selectOption({ label: "Jordan Ellis" });
  await form.getByRole("combobox", { name: "Vehicle" }).selectOption({ label });
  await form.getByRole("button", { name: "Assign driver" }).click();
  await expect(dialog.locator(".assignedDriver")).toContainText(
    `Jordan Ellis · ${label}`,
  );
  // Retire it: the load keeps it, and it can no longer be picked.
  await page.goto("/fleet");
  const row = page
    .getByRole("table", { name: "Vehicles" })
    .getByRole("row", { name: new RegExp(label) });
  await expect(row).toContainText("1");
  await row.getByRole("button", { name: /^Retire/ }).click();
  await page
    .getByRole("dialog", { name: "Retire vehicle" })
    .getByRole("button", { name: "Retire vehicle", exact: true })
    .click();
  await page.goto(`/loads/${load.id}`);
  await expect(
    page
      .getByRole("dialog", { name: "Load details" })
      .locator(".assignedDriver"),
  ).toContainText(label);
  const picker = page
    .getByRole("dialog", { name: "Load details" })
    .getByRole("combobox", { name: "Vehicle" });
  await expect(
    picker.locator("option", { hasText: `${label} (retired)` }),
  ).toHaveCount(1);
});

test("a carrier manager sees their own fleet; a driver has no fleet page", async ({
  page,
}) => {
  await login(page, "carrier@relay.test");
  await page.goto("/fleet");
  await expect(page.getByRole("region", { name: "Fleet" })).toBeVisible();
  await page.context().clearCookies();
  await login(page, "driver@relay.test");
  expect(
    (await page.request.get("/api/fleet?carrier_id=" + randomUUID())).status(),
  ).toBe(404);
  const me = await (await page.request.get("/api/me")).json();
  expect(
    (
      await page.request.get("/api/fleet?carrier_id=" + me.carriers[0].id)
    ).status(),
  ).toBe(404);
  await page.goto("/fleet");
  await expect(page.locator(".alert.error")).toContainText(
    /couldn.t find that/,
  );
  await expect.poll(() => path(page)).toBe("/");
  await expect(
    page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("button", { name: "Fleet" }),
  ).toHaveCount(0);
});

test("the fleet page has no accessibility violations and fits a phone", async ({
  page,
}) => {
  await login(page);
  await page.goto("/fleet");
  await expect(page.getByRole("table", { name: "Drivers" })).toBeVisible();
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
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
  expect(violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("table", { name: "Drivers" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("fleet: summary tiles, and on a phone the tables scroll sideways under their headers", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fleet");
  const tiles = page.getByRole("group", { name: "Fleet summary" });
  await expect(tiles).toContainText("Vehicles in service");
  await expect(tiles).toContainText("Drivers active");
  const drivers = page.getByRole("table", { name: "Drivers" });
  await expect(drivers).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // Headers stay visible on phones; cells never repeat the field name.
  await expect(
    drivers.getByRole("columnheader", { name: "Status" }),
  ).toBeVisible();
  await expect(drivers.locator("[data-label]")).toHaveCount(0);
  // The row's name stays in place while the rest scrolls.
  expect(
    await drivers
      .locator("tbody th")
      .first()
      .evaluate((el) => getComputedStyle(el).position),
  ).toBe("sticky");
});
