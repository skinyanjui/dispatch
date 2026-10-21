import { test, expect } from "@playwright/test";
test("current demo shares app workflows, saves locally and never calls authenticated APIs", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  await page.route("**/api/**", (route) => {
    apiRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/demo.html");
  await expect(page).toHaveURL(/\/demo$/);
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^RL-103/ }).click();
  await expect(
    page.getByRole("article", { name: "Check-in: Chattanooga, TN" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close load details" }).click();
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  await page.getByRole("button", { name: "Add carrier", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "Carrier setup" });
  await setup
    .getByLabel("Company name", { exact: true })
    .fill("Demo New Carrier");
  await setup
    .getByLabel("Contact name", { exact: true })
    .fill("Sample Contact");
  await setup
    .getByLabel("Contact email", { exact: true })
    .fill("sample@example.test");
  await setup
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  await expect(
    setup.getByRole("heading", { name: "Confirm dispatch authority." }),
  ).toBeVisible();
  await setup.getByLabel("Signed agreement file").setInputFiles({
    name: "demo-agreement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% fictional demo agreement\n%%EOF\n"),
  });
  await setup
    .getByLabel("Agreement reference")
    .fill("Demo-only agreement reference");
  await setup.getByRole("checkbox").check();
  await setup
    .getByRole("button", { name: "Save agreement and continue" })
    .click();
  await setup.getByRole("button", { name: "Add driver", exact: true }).click();
  await setup.getByLabel("Driver name").fill("Sample Driver");
  await setup.getByLabel("Driver email").fill("driver@example.test");
  await setup.getByRole("button", { name: "Create driver invitation" }).click();
  const link = await setup
    .getByRole("textbox", { name: "Invitation link" })
    .inputValue();
  expect(link).toContain("/demo/join#");
  await page.goto(link);
  await page
    .getByLabel("Choose a password")
    .fill("DemoPasswordNeverStored2026");
  await page
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome aboard." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open my loads" }).click();
  await expect(
    page.getByRole("heading", { name: "My loads", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "DemoPasswordNeverStored2026",
  );
  await page.getByLabel("Demo role").selectOption("dispatcher");
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Demo New Carrier", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Demo New Carrier", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Demo New Carrier", exact: true }),
  ).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});
test("driver demo uses a focused mobile view and the legacy prototype stays accessible separately", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  await page.getByLabel("Demo role").selectOption("driver");
  await expect(
    page.getByRole("heading", { name: "My loads", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Carriers", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/legacy-demo.html");
  await expect(page.locator("#loadTable")).toBeAttached();
});
