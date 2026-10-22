import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  const response = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(response.status()).toBe(200);
}
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("account: Profile and Security tabs, two aligned columns on a desktop, one on a phone", async ({
  page,
}) => {
  await login(page);
  for (const [width, columns] of [
    [1440, 2],
    [390, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/account");
    const region = page.getByRole("region", { name: "Account settings" });
    const tabs = region.getByRole("tablist", { name: "Account" });
    await expect(tabs.getByRole("tab")).toHaveText(["Profile", "Security"]);
    await expect(tabs.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      region.getByRole("heading", { name: "Profile" }),
    ).toBeVisible();
    await expect(
      region.getByRole("heading", { name: "Change password" }),
    ).toHaveCount(0);
    for (const tab of ["Profile", "Security"]) {
      await tabs.getByRole("tab", { name: tab }).click();
      const lefts = await region
        .locator(".opsCard")
        .evaluateAll((els) => [
          ...new Set(
            els.map((e) => Math.round(e.getBoundingClientRect().left)),
          ),
        ]);
      expect(lefts.length).toBe(columns);
      expect(await noOverflow(page)).toBe(true);
    }
    await expect(
      region.getByRole("heading", { name: "Two-step verification" }),
    ).toBeVisible();
    await tabs.getByRole("tab", { name: "Security" }).press("Home");
    await expect(tabs.getByRole("tab", { name: "Profile" })).toBeFocused();
  }
});

test("notifications: the delivery log shows 20 at a time", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/notifications");
  const region = page.getByRole("region", { name: "Notifications" });
  await expect(
    region.getByRole("group", { name: "Email me about" }),
  ).toBeVisible();
  const rows = region.getByRole("article");
  await expect
    .poll(async () => await rows.count(), { timeout: 10000 })
    .toBeGreaterThanOrEqual(0);
  const first = await rows.count();
  expect(first).toBeLessThanOrEqual(20);
  const more = region.getByRole("button", { name: /^Show more/ });
  if (await more.count()) {
    expect(first).toBe(20);
    await more.click();
    expect(await rows.count()).toBeGreaterThan(20);
  }
  expect(await noOverflow(page)).toBe(true);
});

test("organization: People use one type scale and the AI limit field is short", async ({
  page,
}) => {
  await login(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/organization");
    await page.getByRole("tab", { name: /^People/ }).click();
    const sizes = await page.evaluate(() => {
      const px = (s: string) =>
        parseFloat(getComputedStyle(document.querySelector(s)!).fontSize);
      return {
        name: px(".orgPeople .opsTeamName"),
        role: px(".orgPeople .orgMeta"),
        email: px(".orgPeople .opsTeamName small"),
      };
    });
    expect(sizes.role).toBeLessThanOrEqual(sizes.name);
    expect(sizes.email).toBeLessThanOrEqual(sizes.role);
    await page.getByRole("tab", { name: "AI" }).click();
    const field = page.getByLabel("Monthly limit (USD)");
    await expect(field).toBeVisible();
    expect((await field.boundingBox())!.width).toBeLessThanOrEqual(201);
    expect(await noOverflow(page)).toBe(true);
  }
});

test("link pages: the heading fits the card and the form has room", async ({
  page,
}) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/reset-password#" + "a".repeat(64));
    const heading = page.getByRole("heading", {
      name: "Choose a new password.",
    });
    await expect(heading).toBeVisible();
    const size = await heading.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );
    expect(size).toBeLessThanOrEqual(28);
    const h = (await heading.boundingBox())!;
    const field = (await page
      .getByLabel(/^New password/)
      .first()
      .boundingBox())!;
    // The first field sits clear of the heading, not jammed under it.
    expect(field.y - (h.y + h.height)).toBeGreaterThan(12);
    expect(await noOverflow(page)).toBe(true);
  }
});

test("the footer sits at the bottom of the window on short pages", async ({
  page,
}) => {
  await login(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/account", "/organization", "/inbox", "/assistant"]) {
      await page.goto(path);
      const footer = page.locator(".appShell .workspace > footer");
      await expect(footer).toBeVisible();
      const gap = await page.evaluate(() => {
        const f = document.querySelector(".appShell .workspace > footer")!;
        const main = f.parentElement!.getBoundingClientRect();
        return {
          below: main.bottom - f.getBoundingClientRect().bottom,
          fills: main.bottom >= innerHeight - 12, // the grey frame is 9px
        };
      });
      expect(gap.fills, path).toBe(true);
      expect(gap.below, path).toBeLessThanOrEqual(24);
    }
  }
});
