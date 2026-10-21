import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page) {
  const login = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
}
const dock = (page: Page) => page.locator(".sidebarDock");
const goTo = (page: Page, name: RegExp) =>
  dock(page).getByRole("button", { name }).first().click();

test("one search box sits at the top of the sidebar on every searchable page", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  const pages: [RegExp, string][] = [
    [/^Loads/, "Search loads"],
    [/^Exceptions/, "Search exceptions"],
    [/^Inbox/, "Search conversations"],
    [/^Contacts/, "Search contacts"],
    [/^Carriers/, "Search carriers"],
    [/^Prospects/, "Search prospects"],
    [/^Assistant/, "Search conversations"],
    [/^Billing/, "Search invoices and loads"],
    [/^Reports/, "Search carriers"],
  ];
  for (const [name, label] of pages) {
    await goTo(page, name);
    const box = dock(page).getByRole("searchbox", { name: label });
    await expect(box).toBeVisible();
    // It is the first thing in the sidebar after the brand row.
    const top = await box.boundingBox();
    const brand = await dock(page).locator(".sidebarTop").boundingBox();
    expect(top!.y).toBeGreaterThan(brand!.y);
    expect(top!.y).toBeLessThan(brand!.y + 80);
    // Pages do not carry a second search box of their own.
    await expect(page.getByRole("searchbox")).toHaveCount(1);
  }
  // Settings pages have nothing to filter.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
});

test("typing in the sidebar search filters the open page, and Ctrl+K focuses it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await goTo(page, /^Carriers/);
  const box = dock(page).getByRole("searchbox", { name: "Search carriers" });
  await page.keyboard.press("Control+k");
  await expect(box).toBeFocused();
  const rows = page.locator(".directoryRow");
  const all = await rows.count();
  expect(all).toBeGreaterThan(1);
  await box.fill("Blue Ridge");
  await expect(rows).toHaveCount(1);
  await box.fill("zzz-no-such-carrier");
  await expect(rows).toHaveCount(0);
  // Each page keeps its own text.
  await goTo(page, /^Contacts/);
  await expect(
    dock(page).getByRole("searchbox", { name: "Search contacts" }),
  ).toHaveValue("");
  await goTo(page, /^Carriers/);
  await expect(box).toHaveValue("zzz-no-such-carrier");
});

test("the sidebar is only as wide as its content, and collapsed it keeps a search icon", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const width = (await dock(page).boundingBox())!.width;
  expect(width).toBeGreaterThanOrEqual(160);
  expect(width).toBeLessThanOrEqual(262);
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  expect((await dock(page).boundingBox())!.width).toBeLessThan(70);
  await dock(page).getByRole("button", { name: "Search loads" }).click();
  await expect(
    dock(page).getByRole("searchbox", { name: "Search loads" }),
  ).toBeFocused();
});

test("on a phone the search is in the navigation drawer and nothing overflows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(
    drawer.getByRole("searchbox", { name: "Search loads" }),
  ).toBeVisible();
});
