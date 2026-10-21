import { test, expect } from "@playwright/test";
test("authenticated queue, details and mobile layout", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("dispatcher@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Dispatch board" }),
  ).toBeVisible();
  await page.getByPlaceholder("Search reference…").fill("RL-101");
  await expect(
    page.getByRole("button", { name: "RL-101", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "RL-101", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Load details" }),
  ).toContainText("Chicago, IL");
  await page.getByRole("button", { name: "Close" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Dispatch board" }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/mobile-workspace.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "artifacts/desktop-workspace.png",
    fullPage: true,
  });
});
test("anonymous API rejected and original demo preserved", async ({
  request,
  page,
}) => {
  const res = await request.get("/api/loads");
  expect(res.status()).toBe(401);
  await page.goto("/demo.html");
  await expect(page.locator("#loadTable")).toBeAttached();
});

test("create, assign, dispatch, reject cross-origin writes and revoke session", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("dispatcher@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Create load", exact: false }).click();
  const modal = page.getByRole("dialog", { name: "Create load" });
  const reference = "BROWSER-" + Date.now();
  await modal.getByLabel("Load reference").fill(reference);
  await modal.getByLabel("Booking source").fill("Fictional browser test");
  await modal.getByLabel("Agreed rate").fill("250000");
  await modal
    .getByRole("group", { name: "pickup", exact: true })
    .getByLabel("Address")
    .fill("Chicago, IL");
  await modal
    .getByRole("group", { name: "pickup", exact: true })
    .getByLabel("Appointment")
    .fill("2026-11-05T09:00");
  await modal
    .getByRole("group", { name: "delivery", exact: true })
    .getByLabel("Address")
    .fill("Nashville, TN");
  await modal
    .getByRole("group", { name: "delivery", exact: true })
    .getByLabel("Appointment")
    .fill("2026-11-06T09:00");
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal).not.toBeVisible();
  await page.getByPlaceholder("Search reference…").fill(reference);
  await page.getByRole("button", { name: reference, exact: true }).click();
  const details = page.getByRole("dialog", { name: "Load details" });
  await details.getByLabel("Authorized driver").selectOption({ index: 1 });
  await details
    .getByRole("button", { name: "Assign driver", exact: true })
    .click();
  await expect(
    details.locator(".event").filter({ hasText: "Driver assigned" }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Record next milestone" }).click();
  await expect(details.locator(".badge")).toHaveText("dispatched");
  await page.keyboard.press("Escape");
  await expect(details).not.toBeVisible();
  const rejected = await page.request.post("/api/logout", {
    headers: { Origin: "https://untrusted.example" },
    data: {},
  });
  expect(rejected.status()).toBe(403);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  const denied = await page.request.get("/api/loads");
  expect(denied.status()).toBe(401);
});
