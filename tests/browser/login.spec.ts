import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

async function scan(page: Page, name: string) {
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
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
    });
    return r.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  });
  expect(violations, name).toEqual([]);
}
const signedOut = (page: Page) =>
  page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } }),
  );

test("sign-in is two columns: hero on the left, a card on the right, only real options", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedOut(page);
  await page.goto("/");
  const hero = page.getByRole("complementary", { name: "About Relay" });
  const card = page.locator(".authCard");
  await expect(hero).toBeVisible();
  await expect(card).toBeVisible();
  const [h, c] = [await hero.boundingBox(), await card.boundingBox()];
  expect(h!.x + h!.width).toBeLessThanOrEqual(c!.x);
  await expect(
    page.getByRole("heading", { name: "Sign in", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Everything in motion. All in one place.",
    }),
  ).toBeVisible();
  // Icons inside the fields, and one primary action.
  await expect(card.locator(".fieldBox svg")).toHaveCount(3);
  await expect(card.getByRole("button", { name: "Sign in" })).toBeVisible();
  // Social sign-in only appears once the operator configures it, and
  // there is no open sign-up; people ask for access instead.
  for (const text of [/Google/i, /Apple/i, /Create an account/i])
    await expect(page.getByRole("button", { name: text })).toHaveCount(0);
  await expect(
    card.getByLabel("Keep me signed in for 30 days"),
  ).not.toBeChecked();
  await expect(card.getByRole("link", { name: "Terms" })).toHaveAttribute(
    "href",
    "/terms",
  );
  await expect(card.getByRole("link", { name: "Privacy" })).toHaveAttribute(
    "href",
    "/privacy",
  );
  await expect(
    card.getByRole("link", { name: /Try the interactive demo/ }),
  ).toHaveAttribute("href", "/demo");
  await scan(page, "sign-in desktop");
});

test("the eye button shows and hides the password and works from the keyboard", async ({
  page,
}) => {
  await signedOut(page);
  await page.goto("/");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("secret-value-123");
  await expect(password).toHaveAttribute("type", "password");
  const eye = page.getByRole("button", { name: "Show password" });
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await eye.focus();
  await page.keyboard.press("Enter");
  await expect(password).toHaveAttribute("type", "text");
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(password).toHaveAttribute("type", "password");
  // Forgot password opens the reset form inside the same card.
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(
    page.getByRole("form", { name: "Reset password" }),
  ).toBeVisible();
  await expect(
    page.locator(".authCard").getByLabel("Account email"),
  ).toBeVisible();
});

test("on a phone the hero becomes a band, the card fits, and nothing overflows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedOut(page);
  await page.goto("/");
  await expect(page.locator(".authCard")).toBeVisible();
  await expect(
    page.getByText("Fictional QA data. No live freight connections."),
  ).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const box = await page.locator(".authCard").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await scan(page, "sign-in phone");
});

test("the invitation page shares the layout and is accessible", async ({
  page,
}) => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/join");
    await expect(page.locator(".authCard")).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "About Relay" }),
    ).toBeVisible();
    await scan(page, "join " + size.width);
  }
});

test("keep me signed in is sent only when chosen", async ({ page }) => {
  await signedOut(page);
  const bodies: unknown[] = [];
  await page.route("**/api/login", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 401,
      json: { error: "INVALID_CREDENTIALS" },
    });
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("a@b.test");
  await page.getByLabel("Password", { exact: true }).fill("not-a-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await page.getByLabel("Keep me signed in for 30 days").check();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies).toMatchObject([{ remember: false }, { remember: true }]);
});

test("Terms and Privacy pages exist, say they are drafts, and are accessible", async ({
  page,
}) => {
  for (const [path, heading] of [
    ["/terms", "Terms of use"],
    ["/privacy", "Privacy"],
  ]) {
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: heading, level: 1 }),
      ).toBeVisible();
      await expect(page.getByRole("note")).toContainText(
        "not reviewed by a lawyer",
      );
      await expect(
        page.getByText(/Version \d{4}-\d{2}-\d{2}\.\d/),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await scan(page, path + " " + size.width);
    }
  }
  await page.goto("/privacy");
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
});
