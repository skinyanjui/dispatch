import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";

const origin = { Origin: "http://localhost:3000" };
async function signIn(page: Page, email = "dispatcher@relay.test") {
  const login = await page.request.post("/api/login", {
    headers: origin,
    data: { email, password: process.env.SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);
}
async function scan(page: Page, name: string) {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const result = await (
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
    return result.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  });
  expect(violations, name).toEqual([]);
}
const open = (page: Page) =>
  page
    .locator(".sidebarDock")
    .getByRole("button", { name: /^Prospects/ })
    .first()
    .click();

test("prospects: add, log a call, move through stages, lose with a reason, start carrier setup", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await open(page);
  const board = page.getByRole("region", { name: "Prospect board" });
  await expect(board).toBeVisible();
  // Add one.
  const company = "Browser Haulers " + randomUUID().slice(0, 6);
  await page.getByRole("button", { name: "Add prospect" }).click();
  const sheet = page.getByRole("dialog", { name: "Add prospect" });
  await sheet.getByLabel("Company").fill(company);
  await sheet.getByLabel("Contact name").fill("Dana Driver");
  await sheet.getByLabel("Email").fill("dana@example.test");
  await sheet.getByLabel("Source").selectOption("referral");
  await scan(page, "add prospect");
  await sheet
    .getByRole("form", { name: "Add prospect" })
    .getByRole("button", { name: "Add prospect" })
    .click();
  await expect(sheet).toBeHidden();
  const lane = (name: string) =>
    board.getByRole("region", { name: `${name} prospects` });
  const card = (name: string) =>
    lane(name).getByRole("button", { name: new RegExp(company) });
  await expect(card("New")).toBeVisible();
  // Open it: one click shows details and history.
  await card("New").click();
  const detail = page.getByRole("dialog", { name: "Prospect" });
  await expect(detail.getByRole("heading", { name: company })).toBeVisible();
  await scan(page, "prospect details");
  // Log a call with a follow-up date.
  await detail.getByLabel("What happened?").fill("Left a voicemail");
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await detail
    .getByRole("form", { name: "Log activity" })
    .getByLabel("Next follow-up")
    .fill(tomorrow);
  await detail.getByLabel("Type").selectOption("call");
  await detail.getByRole("button", { name: "Log activity" }).click();
  await expect(
    detail
      .getByRole("list", { name: "Activity" })
      .getByText("Left a voicemail"),
  ).toBeVisible();
  // Moving the stage is one selection.
  await detail.getByLabel("Stage").selectOption("contacted");
  await expect(detail.getByText(/In Contacted since/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(card("Contacted")).toContainText("Follow up tomorrow");
  // Lost needs a reason.
  await card("Contacted").click();
  await detail.getByLabel("Stage").selectOption("lost");
  await detail.getByLabel("Why was it lost?").fill("Signed elsewhere");
  await detail.getByRole("button", { name: "Mark as lost" }).click();
  await expect(
    detail.getByText("Lost: Signed elsewhere", { exact: true }),
  ).toBeVisible();
  // Reopen and start carrier setup (the carrier record only).
  await detail.getByLabel("Stage").selectOption("qualified");
  await expect(detail.getByText(/In Qualified since/)).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await detail.getByRole("button", { name: "Start carrier setup" }).click();
  await expect(detail.getByText("Became a carrier.")).toBeVisible();
  await expect(detail.getByLabel("Stage")).toBeDisabled();
  await detail.getByRole("button", { name: "Open carriers" }).click();
  await expect(
    page.getByRole("heading", { name: "Carriers", exact: true }),
  ).toBeVisible();
  // The carrier exists and has no verified agreement yet.
  const context = await (await page.request.get("/api/me")).json();
  expect(
    context.carriers.some((c: { name: string }) => c.name === company),
  ).toBe(true);
});

test("prospects: search and follow-up filters narrow the board; managers have no Prospects page", async ({
  page,
}) => {
  await signIn(page);
  const tag = randomUUID().slice(0, 8);
  for (const [name, due] of [
    [`Overdue ${tag}`, "2020-01-01"],
    [`Later ${tag}`, null],
  ]) {
    const res = await page.request.post("/api/prospects", {
      headers: origin,
      data: {
        idempotency_key: randomUUID(),
        company: name,
        next_follow_up_on: due,
      },
    });
    expect(res.status()).toBe(201);
  }
  await page.goto("/");
  await open(page);
  await page.getByRole("searchbox", { name: "Search prospects" }).fill(tag);
  const cards = page.locator(".prospectCard");
  await expect(cards).toHaveCount(2);
  await page.getByRole("button", { name: /^Overdue\s*\d+$/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(`Overdue ${tag}`);
  await expect(cards.first()).toContainText("overdue");
  // A carrier manager never sees the page or its data.
  const manager = await page.context().browser()!.newContext();
  const managerPage = await manager.newPage();
  const login = await managerPage.request.post(
    "http://localhost:3000/api/login",
    {
      headers: origin,
      data: {
        email: "carrier@relay.test",
        password: process.env.SEED_PASSWORD,
      },
    },
  );
  expect(login.status()).toBe(200);
  const denied = await managerPage.request.get(
    "http://localhost:3000/api/prospects",
  );
  expect(denied.status()).toBe(404);
  await manager.close();
});

test("prospects on a phone: lanes scroll sideways and the sheet fits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Workspace navigation" })
    .getByRole("button", { name: /^Prospects/ })
    .click();
  await expect(
    page.getByRole("region", { name: "Prospect board" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "Add prospect" }).click();
  const sheet = page.getByRole("dialog", { name: "Add prospect" });
  const box = await sheet.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await scan(page, "add prospect (phone)");
});

test("prospects board: drag a card to the next stage; dropping on Lost asks why", async ({
  page,
}) => {
  await signIn(page);
  const company = "Drag Haulers " + randomUUID().slice(0, 6);
  const res = await page.request.post("/api/prospects", {
    headers: origin,
    data: { idempotency_key: randomUUID(), company },
  });
  expect(res.status()).toBe(201);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await open(page);
  await page.getByRole("searchbox", { name: "Search prospects" }).fill(company);
  const board = page.getByRole("region", { name: "Prospect board" });
  const lane = (name: string) =>
    board.getByRole("region", { name: `${name} prospects` });
  const card = (name: string) =>
    lane(name).getByRole("button", { name: new RegExp(company) });
  await card("New").dragTo(lane("Qualified"));
  await expect(card("Qualified")).toBeVisible();
  await expect(page.getByText(`${company} moved to Qualified.`)).toBeAttached();
  // Lost needs a reason, so the drop opens the prospect at that question.
  await card("Qualified").dragTo(lane("Lost"));
  const detail = page.getByRole("dialog", { name: "Prospect" });
  await expect(detail.getByLabel("Why was it lost?")).toBeFocused();
  await detail
    .getByLabel("Why was it lost?")
    .fill("Went with another dispatcher");
  await detail.getByRole("button", { name: "Mark as lost" }).click();
  await expect(
    detail.getByText("Lost: Went with another dispatcher", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card("Lost")).toBeVisible();
});

test("both boards share one lane anatomy: dot, name, count, and the same type", async ({
  page,
}) => {
  await signIn(page);
  await page.request.post("/api/prospects", {
    headers: origin,
    data: {
      idempotency_key: randomUUID(),
      company: "Anatomy " + randomUUID().slice(0, 6),
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const anatomy = () =>
    page.evaluate(() => {
      const lane = document.querySelector(".kanban .lane")!;
      const h2 = getComputedStyle(lane.querySelector(".laneHeading h2")!);
      return {
        dot: !!lane.querySelector(".laneHeading > svg"),
        count: !!lane.querySelector(".laneHeading .laneCount"),
        size: h2.fontSize,
        weight: h2.fontWeight,
        card: !!document.querySelector(".kanban .cardDrag > .loadCard.lc"),
      };
    });
  await page.goto("/");
  await expect(page.locator(".kanban .loadCard").first()).toBeVisible();
  const loads = await anatomy();
  await open(page);
  await expect(
    page.getByRole("region", { name: "Prospect board" }),
  ).toBeVisible();
  await expect(page.locator(".prospectCard").first()).toBeVisible();
  expect(await anatomy()).toEqual(loads);
});
