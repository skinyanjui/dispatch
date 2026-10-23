import { test, expect } from "@playwright/test";

const signIn = async (
  request: import("@playwright/test").APIRequestContext,
) => {
  const res = await request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(res.status()).toBe(200);
};

test("account: the Security tab lists sessions and signs out the others", async ({
  page,
  browser,
}) => {
  await signIn(page.request);
  const other = await browser.newContext({ baseURL: "http://localhost:3000" });
  await signIn(other.request);
  await page.goto("/account");
  const region = page.getByRole("region", { name: "Account settings" });
  await region.getByRole("tab", { name: "Security" }).click();
  const card = region.getByRole("article", { name: "Signed-in sessions" });
  await expect(card.getByText("This device")).toBeVisible();
  await expect(card.getByText("Another device").first()).toBeVisible();
  await card.getByRole("button", { name: "Sign out everywhere else" }).click();
  await expect(card.getByRole("status")).toHaveText(
    "All other sessions were signed out.",
  );
  await expect(card.getByText("Another device")).toHaveCount(0);
  await expect(
    card.getByText("You're signed in on this device only."),
  ).toBeVisible();
  // The other browser really is signed out.
  expect((await other.request.get("/api/me")).status()).toBe(401);
  await other.close();
});
