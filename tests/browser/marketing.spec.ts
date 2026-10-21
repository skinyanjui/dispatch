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

const pages: [string, string][] = [
  ["/welcome", "Everything in motion. All in one place."],
  ["/how-it-works", "From rate confirmation to dispatch invoice"],
  ["/get-started", "From request to first load"],
];

test("public pages render, are accessible, fit phones and link to real destinations", async ({
  page,
}) => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: heading, level: 1 }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await scan(page, path + " " + size.width);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/welcome");
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Request access" })
      .first(),
  ).toHaveAttribute("href", "/request-access");
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toHaveAttribute("href", "/");
  // No invented customers, prices or live claims.
  await expect(page.locator("body")).not.toContainText(
    /\$\d|testimonial|trusted by/i,
  );
  await expect(page.getByRole("main")).toContainText("fictional sample data");
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/get-started$/);
  await page.getByText("Does it cost anything?").click();
  await expect(page.getByText("no pricing yet")).toBeVisible();
});
