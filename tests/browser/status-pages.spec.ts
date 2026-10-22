import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";

test("an unknown address shows the 404 page with a way back", async ({
  page,
}) => {
  const response = await page.goto("/no/such/page");
  expect(response!.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: /find that page/ }),
  ).toBeVisible();
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
          ) => Promise<{ violations: { id: string }[] }>;
        };
      }
    ).axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
    return r.violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);
  await page.getByRole("link", { name: "Go to Relay" }).click();
  await expect(page).toHaveURL(/\/$/);
});
