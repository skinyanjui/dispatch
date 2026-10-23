import { test, expect } from "@playwright/test";

/**
 * The demo's Fleet page (ADR 0048) runs on browser-only fictional data: it
 * lists vehicles and drivers, follows the same rules as the app, and a vehicle
 * can be chosen when a driver is assigned. It never calls the real API.
 */
test("demo fleet: lists vehicles and drivers, adds, refuses a duplicate, retires, and picks a vehicle on a load", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  await page.route("**/api/**", (route) => {
    apiRequests.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await nav.getByRole("button", { name: "Fleet", exact: true }).click();

  await expect(page.locator(".alert.error")).toHaveCount(0);
  const vehicles = page.getByRole("table", { name: "Vehicles" });
  await expect(vehicles).toContainText("Unit 12");
  await expect(vehicles).toContainText("Box 4");
  await expect(page.getByRole("table", { name: "Drivers" })).toContainText(
    "Jordan Ellis",
  );

  // Add, then the same name again is refused in plain words.
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add vehicle" });
  await sheet.getByLabel("Unit name").fill("Unit 99");
  await sheet.getByLabel("Plate (optional)").fill("ab 1234");
  await sheet.getByRole("button", { name: "Add vehicle", exact: true }).click();
  const row = vehicles.getByRole("row", { name: /Unit 99/ });
  await expect(row).toContainText("AB 1234");
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const again = page.getByRole("dialog", { name: "Add vehicle" });
  await again.getByLabel("Unit name").fill("unit 99");
  await again.getByRole("button", { name: "Add vehicle", exact: true }).click();
  await expect(again.getByRole("alert")).toContainText(/already has a vehicle/);
  await again.getByRole("button", { name: "Cancel" }).click();

  // Retire hides it until "Show retired".
  await row.getByRole("button", { name: /^Retire/ }).click();
  await page
    .getByRole("dialog", { name: "Retire vehicle" })
    .getByRole("button", { name: "Retire vehicle", exact: true })
    .click();
  await expect(row).toHaveCount(0);

  // A vehicle is offered when a driver is assigned, and shown on the load.
  await nav.getByRole("button", { name: "Loads", exact: true }).click();
  await page.getByRole("button", { name: /^RL-101/ }).click();
  const dialog = page.getByRole("dialog", { name: "Load details" });
  const form = dialog.locator(".assignForm");
  await form
    .getByRole("combobox", { name: "Authorized driver" })
    .selectOption({ label: "Jordan Ellis" });
  const picker = form.getByRole("combobox", { name: "Vehicle" });
  await expect(picker.locator("option", { hasText: "Unit 99" })).toHaveCount(0);
  await picker.selectOption({ label: "Unit 12" });
  await form.getByRole("button", { name: "Assign driver" }).click();
  await expect(dialog.locator(".assignedDriver")).toContainText(
    "Jordan Ellis · Unit 12",
  );
  expect(apiRequests).toEqual([]);
});
