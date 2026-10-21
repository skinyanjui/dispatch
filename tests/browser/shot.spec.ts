import { test } from "@playwright/test";
const S = "/tmp/claude-0/-home-user-dispatch/3953eefa-2efe-5f56-9bb0-7b61a2c4f643/scratchpad/";
test("c", async ({ page }) => {
  await page.request.post("/api/login", { headers: { Origin: "http://localhost:3000" }, data: { email: "dispatcher@relay.test", password: process.env.SEED_PASSWORD } });
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/");
    if (w < 900) { await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("dialog", { name: "Workspace navigation" }).getByRole("button", { name: "Carriers", exact: true }).click(); }
    else await page.getByRole("button", { name: "Carriers", exact: true }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${S}car-${w}.png` });
  }
});
