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
  // Nothing that does not exist in Relay is offered as a control.
  for (const text of [
    /Google/i,
    /Apple/i,
    /Remember me/i,
    /Create an account/i,
    /Terms/i,
  ])
    await expect(page.getByRole("button", { name: text })).toHaveCount(0);
  for (const text of [/Google/i, /Apple/i, /Create an account/i, /Terms/i])
    await expect(page.getByRole("link", { name: text })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
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
