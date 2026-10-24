import { test, expect, type Page } from "@playwright/test";
import { menu } from "../../src/lib/marketing-menu";

/**
 * The public mega menu and phone menu, and where the logo goes: the public
 * home from public pages and sign-in, and the page a person uses most inside
 * the app.
 */
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const trigger = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name });
const login = async (page: Page, email: string) => {
  const r = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(r.status()).toBe(200);
};

test("the mega menu opens by click, hover and keyboard, and closes with Escape, outside click and navigation", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto("/welcome");
  const product = trigger(page, "Product");
  await expect(product).toHaveAttribute("aria-expanded", "false");
  await product.click();
  const panel = page.getByRole("region", { name: "Product menu" });
  await expect(product).toHaveAttribute("aria-expanded", "true");
  await expect(
    panel.getByRole("link", { name: /Board, table and calendar/ }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Open the interactive demo" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(product).toBeFocused();
  // Keyboard: ArrowDown opens and lands on the first link.
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Escape");
  // Hover opens one menu and moving to another swaps it; leaving closes it.
  await trigger(page, "How it works").hover();
  await expect(
    page.getByRole("region", { name: "How it works menu" }),
  ).toBeVisible();
  await trigger(page, "Resources").hover();
  await expect(
    page.getByRole("region", { name: "How it works menu" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Resources menu" }),
  ).toBeVisible();
  await page.mouse.move(700, 800);
  await expect(
    page.getByRole("region", { name: "Resources menu" }),
  ).toHaveCount(0);
  // Outside click closes.
  await product.click();
  await page.mouse.click(700, 700);
  await expect(panel).toHaveCount(0);
  // A link navigates to its section and closes the menu.
  await product.click();
  await page
    .getByRole("region", { name: "Product menu" })
    .getByRole("link", { name: /Assign and dispatch/ })
    .click();
  await expect(page).toHaveURL(/\/welcome#assign$/);
  await expect(page.getByRole("region", { name: "Product menu" })).toHaveCount(
    0,
  );
  await expect(page.locator("#assign")).toBeInViewport();
});

test("every menu link reaches a real page and a real section", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  const links = menu.flatMap((e) =>
    e.kind === "link"
      ? [e.href]
      : [
          ...e.groups.flatMap((g) => g.items.map((i) => i.href)),
          e.feature.href,
        ],
  );
  for (const href of new Set(links)) {
    const [path, hash] = href.split("#");
    const response = await page.goto(path);
    expect(response?.status(), href).toBeLessThan(400);
    if (hash) await expect(page.locator("#" + hash), href).toHaveCount(1);
  }
});

test("on a phone the header shows a menu button and the sheet works", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await page.goto("/welcome");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await page.getByRole("button", { name: "Open menu" }).click();
  const sheet = page.getByRole("dialog", { name: "Menu" });
  await expect(sheet).toBeVisible();
  await sheet.getByText("Product", { exact: true }).click();
  await expect(
    sheet.getByRole("link", { name: "Assign and dispatch" }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("link", { name: "Request access" }),
  ).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Sign in" })).toBeVisible();
  await sheet.getByRole("link", { name: "Assign and dispatch" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/#assign$/);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("the menu switches at 900px: mega menu above, sheet below", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/pricing");
  await expect(trigger(page, "Product")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
  await page.setViewportSize({ width: 899, height: 800 });
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(trigger(page, "Product")).toBeHidden();
});

test("the logo takes people to the public home from every public page and from sign-in", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  for (const path of [
    "/pricing",
    "/how-it-works",
    "/get-started",
    "/terms",
    "/privacy",
    "/",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("link", { name: "Relay home" }).first(),
      path,
    ).toHaveAttribute("href", "/welcome");
  }
  await page.goto("/get-started");
  await page.getByRole("link", { name: "Relay home" }).first().click();
  await expect(page).toHaveURL(/\/welcome$/);
});

test("in the app the logo goes to Loads at first, then to the page used most", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await login(page, "dispatcher@relay.test");
  const me = await (await page.request.get("/api/me")).json();
  const visits = () =>
    page.evaluate(
      (id) =>
        JSON.parse(localStorage.getItem(`relay-page-visits:${id}`) || "{}")
          .visits ?? 0,
      me.user.id,
    );
  const logo = page
    .locator(".sidebarTop")
    .getByRole("button", { name: /^Relay, go to/ });
  // The visit is counted once the page knows who is signed in.
  const visit = async (path: string) => {
    await page.goto(path);
    const before = await visits();
    await expect(logo).toBeVisible();
    await expect.poll(visits).toBeGreaterThan(before);
  };
  await page.goto("/exceptions");
  await expect(logo).toHaveAccessibleName("Relay, go to Loads");
  await logo.click();
  await expect(page).toHaveURL(/localhost:3000\/$/);
  // Build a habit: Inbox is opened most.
  for (const path of [
    "/inbox",
    "/contacts",
    "/inbox",
    "/inbox",
    "/exceptions",
    "/inbox",
  ])
    await visit(path);
  await visit("/contacts");
  await page.reload();
  await expect(logo).toHaveAccessibleName("Relay, go to Inbox");
  await logo.click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("on a phone the app's logo does the same, and a driver is never sent to a page they cannot open", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await login(page, "driver@relay.test");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const user = await (await page.request.get("/api/me")).json();
  // A habit for a page drivers may not open (set directly: they cannot visit it).
  await page.evaluate((id) => {
    localStorage.setItem(
      `relay-page-visits:${id}`,
      JSON.stringify({ scores: { billing: 9 }, visits: 9 }),
    );
  }, user.user.id);
  // Account is a utility: opening it counts for nothing.
  await page.goto("/account");
  const bar = page
    .locator(".mobileBar")
    .getByRole("button", { name: /^Relay, go to/ });
  await expect(bar).toHaveAccessibleName("Relay, go to Loads");
  await bar.click();
  await expect(page).toHaveURL(/localhost:3000\/$/);
});
