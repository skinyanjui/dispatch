import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

const origin = { Origin: "http://localhost:3000" };
async function signIn(page: Page) {
  const login = await page.request.post("/api/login", {
    headers: origin,
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
}

test("blocked steps are buttons that lead to the missing piece, not instructions", async ({
  page,
}) => {
  await signIn(page);
  const me = await (await page.request.get("/api/me")).json();
  const carrier = me.carriers.find((c: { name: string }) =>
    c.name.startsWith("Blue Ridge"),
  ).id;
  const start = Date.now() + 48 * 3600000;
  const reference = "ACT-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/loads", {
    headers: { ...origin, "Idempotency-Key": randomUUID() },
    data: {
      carrierId: carrier,
      reference,
      source: "Fictional QA",
      amountMinor: 250000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: new Date(start).toISOString(),
          windowEnd: new Date(start + 3600000).toISOString(),
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: new Date(start + 86400000).toISOString(),
          windowEnd: new Date(start + 90000000).toISOString(),
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  await page.goto("/");
  await page.getByPlaceholder("Search reference…").fill(reference);
  await page.getByRole("button", { name: new RegExp(reference) }).click();
  const dialog = page.getByRole("dialog");
  // No driver yet: the milestone button is the way to get one, and it works.
  const next = dialog.getByRole("button", {
    name: /Choose a driver to continue/,
  });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(dialog.getByLabel("Authorized driver")).toBeFocused();
});

test("an empty exceptions list offers the next step as a button", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/exceptions*", (route) =>
    route.fulfill({
      json: { exceptions: [], truncated: false },
    }),
  );
  await page.goto("/");
  await page
    .locator(".sidebarDock")
    .getByRole("button", { name: /^Exceptions/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "No exceptions match" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Choose a load" }).click();
  await expect(page.getByRole("region", { name: "Load board" })).toBeVisible();
});
