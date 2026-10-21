import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
async function login(page: Page) {
  expect(
    (
      await page.request.post("/api/login", {
        headers: { Origin: "http://localhost:3000" },
        data: {
          email: "dispatcher@relay.test",
          password: process.env.SEED_PASSWORD,
        },
      })
    ).status(),
  ).toBe(200);
}
async function newCarrier(page: Page, email: string, name: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Carrier directory", exact: true })
    .click();
  await page.getByRole("button", { name: "Add carrier", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Carrier setup" });
  await dialog.getByLabel("Company name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Contact name", { exact: true })
    .fill("Taylor Browser QA");
  await dialog.getByLabel("Contact email", { exact: true }).fill(email);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/onboarding/carriers" &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  const id = (await (await response).json()).id;
  await expect(
    dialog.getByRole("heading", { name: "Confirm dispatch authority." }),
  ).toBeVisible();
  return { dialog, id };
}
async function agreement(dialog: ReturnType<Page["getByRole"]>) {
  await dialog
    .getByLabel("Signed agreement reference")
    .fill("Fictional browser signed agreement");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Save agreement and continue" })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Bring your team in." }),
  ).toBeVisible();
}
test("a lost driver invitation response preserves its private link and creates one pending driver", async ({
  page,
}) => {
  await login(page);
  const suffix = randomUUID().slice(0, 8);
  const { dialog, id } = await newCarrier(
    page,
    suffix + "-contact@relay.test",
    "Invite Retry " + suffix,
  );
  await agreement(dialog);
  await dialog.getByRole("button", { name: "Add driver", exact: true }).click();
  const form = dialog.getByRole("form", { name: "Add driver" });
  await form.getByLabel("Driver name").fill("Retry Driver");
  await form.getByLabel("Driver email").fill(suffix + "-driver@relay.test");
  const requests: { key: string; token: string }[] = [];
  let first = true;
  await page.route(
    "**/api/onboarding/carriers/" + id + "/drivers",
    async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ key: body.key, token: body.token });
      if (first) {
        first = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    },
  );
  await form.getByRole("button", { name: "Create driver invitation" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await form.getByRole("button", { name: "Create driver invitation" }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Invitation link" }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  const setup = await (
    await page.request.get("/api/onboarding/carriers/" + id)
  ).json();
  expect(setup.drivers).toHaveLength(1);
});
test("an invitation to an existing account requests its current password before joining", async ({
  page,
  browser,
}) => {
  await login(page);
  const { dialog, id } = await newCarrier(
    page,
    "carrier@relay.test",
    "Existing Account " + randomUUID().slice(0, 8),
  );
  await agreement(dialog);
  await dialog
    .getByRole("button", { name: "Create carrier invitation" })
    .click();
  const link = await dialog
    .getByRole("textbox", { name: "Invitation link" })
    .inputValue();
  const context = await browser.newContext();
  const recipient = await context.newPage();
  await recipient.goto(link);
  await expect(recipient.getByLabel("Choose a password")).toHaveCount(0);
  await recipient
    .getByLabel("Your existing password")
    .fill(process.env.SEED_PASSWORD!);
  await recipient.getByRole("button", { name: "Sign in and join" }).click();
  await expect(
    recipient.getByRole("heading", { name: "Welcome aboard." }),
  ).toBeVisible();
  const memberships = await (await recipient.request.get("/api/me")).json();
  expect(
    memberships.carriers.find((c: { id: string }) => c.id === id).role,
  ).toBe("carrier-manager");
  await context.close();
});

test("dispatcher onboards a carrier, manager invites a driver, and the driver receives only assigned work", async ({
  page,
  browser,
}) => {
  await login(page);
  const suffix = randomUUID().slice(0, 8),
    name = "Browser Carrier " + suffix,
    email = suffix + "-manager@relay.test";
  const { dialog, id } = await newCarrier(page, email, name);
  await agreement(dialog);
  await dialog
    .getByRole("button", { name: "Create carrier invitation" })
    .click();
  const managerLink = await dialog
    .getByRole("textbox", { name: "Invitation link" })
    .inputValue();
  expect(managerLink).toContain("/join#");
  await dialog.getByRole("button", { name: "Finish setup" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Your carrier is ready." }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  await manager.goto(managerLink);
  await expect(
    manager.getByRole("heading", { name: "One step to join." }),
  ).toBeVisible();
  await manager
    .getByLabel("Choose a password")
    .fill("FictionalOnboardingBrowser2026");
  await manager
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  await expect(
    manager.getByRole("heading", { name: "Welcome aboard." }),
  ).toBeVisible();
  await manager.getByRole("link", { name: "Open carrier workspace" }).click();
  await expect(
    manager.getByRole("heading", { name: "Carriers", exact: true }),
  ).toBeVisible();
  await expect(
    manager.getByRole("button", { name: "Add carrier", exact: true }),
  ).toHaveCount(0);
  await manager
    .getByRole("article")
    .filter({ has: manager.getByRole("heading", { name, exact: true }) })
    .getByRole("button", { name: "Manage setup" })
    .click();
  const setup = manager.getByRole("dialog", { name: "Carrier setup" });
  await expect(
    setup.getByRole("button", { name: "Create carrier invitation" }),
  ).toHaveCount(0);
  await setup.getByRole("button", { name: "Add driver", exact: true }).click();
  const form = setup.getByRole("form", { name: "Add driver" });
  await form.getByLabel("Driver name").fill("Avery Driver QA");
  await form.getByLabel("Driver email").fill(suffix + "-driver@relay.test");
  await form.getByRole("button", { name: "Create driver invitation" }).click();
  const driverLink = await setup
    .getByRole("textbox", { name: "Invitation link" })
    .inputValue();
  const driverContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const driver = await driverContext.newPage();
  await driver.goto(driverLink);
  await driver
    .getByLabel("Choose a password")
    .fill("FictionalOnboardingBrowser2026");
  await driver
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  await driver.getByRole("link", { name: "Open my loads" }).click();
  await expect(
    driver.getByRole("heading", { name: "My loads", exact: true }),
  ).toBeVisible();
  await expect(
    driver.getByRole("button", { name: "Create load", exact: true }),
  ).toHaveCount(0);
  await expect(
    driver.getByRole("button", { name: "Carrier directory", exact: true }),
  ).toHaveCount(0);
  await expect(
    driver.getByRole("columnheader", { name: "Agreed rate" }),
  ).toHaveCount(0);
  await expect(
    driver.getByRole("heading", { name: "No assigned loads yet" }),
  ).toBeVisible();
  const state = await (
    await page.request.get("/api/onboarding/carriers/" + id)
  ).json();
  expect(state.drivers[0].onboarding_status).toBe("ready");
  const ref = "ASSIGNED-" + suffix;
  const result = await page.request.post("/api/loads", {
    headers: {
      Origin: "http://localhost:3000",
      "Idempotency-Key": randomUUID(),
    },
    data: {
      carrierId: id,
      reference: ref,
      source: "Fictional onboarding browser QA",
      amountMinor: 10000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "UTC",
          windowStart: "2026-11-05T09:00:00Z",
          windowEnd: "2026-11-05T10:00:00Z",
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "UTC",
          windowStart: "2026-11-06T09:00:00Z",
          windowEnd: "2026-11-06T10:00:00Z",
        },
      ],
    },
  });
  expect(result.status()).toBe(201);
  const load = await result.json();
  expect(
    (
      await page.request.post("/api/loads/" + load.id + "/assign", {
        headers: { Origin: "http://localhost:3000" },
        data: { version: 1, driverId: state.drivers[0].id },
      })
    ).status(),
  ).toBe(200);
  await driver.getByRole("button", { name: "Refresh loads" }).click();
  await driver.getByRole("button", { name: new RegExp("^" + ref) }).click();
  await expect(
    driver.getByRole("button", { name: "Add check-in", exact: true }),
  ).toBeVisible();
  await expect(
    driver.getByRole("button", { name: "Record next milestone" }),
  ).toHaveCount(0);
  expect(
    await driver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await driverContext.close();
  await managerContext.close();
});

test("a lost carrier creation response retries with the same key and resumes its saved step", async ({
  page,
}) => {
  await login(page);
  const keys: string[] = [];
  let first = true;
  await page.route("**/api/onboarding/carriers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().postDataJSON().key);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Carrier directory", exact: true })
    .click();
  await page.getByRole("button", { name: "Add carrier", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Carrier setup" });
  const name = "Retry Carrier " + randomUUID().slice(0, 8);
  await dialog.getByLabel("Company name", { exact: true }).fill(name);
  await dialog.getByLabel("Contact name", { exact: true }).fill("Retry QA");
  await dialog
    .getByLabel("Contact email", { exact: true })
    .fill(randomUUID() + "@relay.test");
  await dialog
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Company name", { exact: true })).toHaveValue(
    name,
  );
  await dialog
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Confirm dispatch authority." }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(
    dialog.getByRole("button", { name: "Close carrier setup" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Close carrier setup" }).click();
  const row = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Manage setup" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Confirm dispatch authority." }),
  ).toBeVisible();
});
