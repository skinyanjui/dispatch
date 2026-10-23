import { randomUUID } from "node:crypto";
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
const tops = (page: Page, labels: string[]) =>
  Promise.all(
    labels.map(async (l) =>
      Math.round((await page.getByLabel(l).first().boundingBox())!.y),
    ),
  );

/** These specs need a conversation; a fresh database has none, so make one. */
async function ensureThread(page: Page) {
  const me = await (await page.request.get("/api/me")).json();
  const sent = await page.request.post("/api/messages", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      idempotency_key: randomUUID(),
      subject: "Composer layout " + randomUUID().slice(0, 6),
      to: ["driver:" + me.drivers[0].id],
      channel: "in_app",
      body: "Checking the composer layout.",
    },
  });
  expect(sent.status()).toBe(201);
}

async function openFirstThread(page: Page) {
  await ensureThread(page);
  await page.goto("/inbox");
  const first = page.locator(".threadItem").first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(
    page.getByRole("form", { name: "Write a message" }),
  ).toBeVisible();
}

test("inbox composer on a desktop: log activity and saved reply share a row", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFirstThread(page);
  const [a, b] = await tops(page, ["Log activity", "Saved reply"]);
  expect(Math.abs(a - b)).toBeLessThan(4);
  expect(await noOverflow(page)).toBe(true);
});

test("inbox composer on a phone: the two choices share a row and the switch fills its row", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFirstThread(page);
  const [a, b] = await tops(page, ["Log activity", "Saved reply"]);
  expect(Math.abs(a - b)).toBeLessThan(4);
  const via = (await page
    .getByRole("group", { name: "Send via" })
    .boundingBox())!;
  expect(via.width).toBeGreaterThan(280);
  expect(await noOverflow(page)).toBe(true);
});
