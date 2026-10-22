import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

const origin = { Origin: "http://localhost:3000" };
async function signIn(page: Page) {
  const login = await page.request.post("/api/login", {
    headers: origin,
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
}
async function setAssistant(page: Page, on: boolean) {
  const state = await (await page.request.get("/api/assistant")).json();
  const ai = await (
    await page.request.get(`/api/organizations/${state.organization_id}/ai`)
  ).json();
  const res = await page.request.post(
    `/api/organizations/${state.organization_id}/ai`,
    {
      headers: origin,
      data: {
        version: ai.version,
        enabled: ai.enabled,
        assistant_enabled: on,
        monthly_limit_cents: 100000,
      },
    },
  );
  expect(res.status()).toBe(200);
}
const open = (page: Page) =>
  page
    .locator(".sidebarDock")
    .getByRole("button", { name: /^Assistant/ })
    .first()
    .click();

test("assistant: an admin turns it on with a button, asks, and opens a source", async ({
  page,
}) => {
  await signIn(page);
  await setAssistant(page, false);
  // A load that needs attention: pickup soon, no driver.
  const me = await (await page.request.get("/api/me")).json();
  const carrier = me.carriers.find((c: { name: string }) =>
    c.name.startsWith("Blue Ridge"),
  ).id;
  const start = Date.now() + 2 * 3600000;
  const reference = "ASK-" + randomUUID().slice(0, 8);
  const created = await page.request.post("/api/loads", {
    headers: { ...origin, "Idempotency-Key": randomUUID() },
    data: {
      carrierId: carrier,
      reference,
      source: "Fictional QA",
      amountMinor: 250000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: new Date(start).toISOString(),
          windowEnd: new Date(start + 3600000).toISOString(),
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: new Date(start + 86400000).toISOString(),
          windowEnd: new Date(start + 90000000).toISOString(),
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  await page.goto("/");
  await open(page);
  await expect(
    page.getByRole("heading", { name: "The assistant is off" }),
  ).toBeVisible();
  // The action is a button, not instructions.
  await page.getByRole("button", { name: "Turn on the assistant" }).click();
  await expect(
    page.getByRole("form", { name: "Ask the assistant" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "What needs my attention right now?" })
    .click();
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log).toContainText("loads need attention");
  await expect(log).toContainText("no AI used");
  // A long-lived database has many loads needing attention, so look this one
  // up by its reference.
  await page.getByLabel("Your question").fill(`Where is ${reference}?`);
  await page.keyboard.press("Enter");
  await expect(log).toContainText(`${reference} (`);
  // Sources are real records; one click opens the load.
  const chip = page
    .getByRole("group", { name: "Sources" })
    .getByRole("button", { name: reference });
  await chip.click();
  await expect(
    page.getByRole("dialog").getByText(reference).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Typing a question works with the keyboard.
  await page
    .getByLabel("Your question")
    .fill("Which prospects need a follow-up?");
  await page.keyboard.press("Enter");
  await expect(log).toContainText("Which prospects need a follow-up?");
  await expect(page.getByLabel("Your question")).toHaveValue("");
  await setAssistant(page, false);
});

test("assistant on a phone fits, and the demo answers from sample data only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/demo");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Workspace navigation" })
    .getByRole("button", { name: /^Assistant/ })
    .click();
  await page
    .getByRole("button", { name: "Which loads have no driver?" })
    .click();
  await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
    "Sample answer",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(requests).toEqual([]);
});

test("documents: make a template, draft from a load and from the assistant, review it", async ({
  page,
}) => {
  await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  const me = await (await page.request.get("/api/me")).json();
  const org = me.organizations.find((o: { role?: string }) => o.role).id;
  const ai = await (
    await page.request.get(`/api/organizations/${org}/ai`)
  ).json();
  await page.request.post(`/api/organizations/${org}/ai`, {
    headers: { Origin: "http://localhost:3000" },
    data: {
      version: ai.version,
      enabled: ai.enabled,
      assistant_enabled: true,
      monthly_limit_cents: 1000,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  const docs = page.getByRole("region", { name: "Documents" });
  await docs.getByRole("tab", { name: /^Templates/ }).click();
  const name = "Check call " + Date.now();
  await docs.getByRole("button", { name: "New template" }).click();
  const form = page.getByRole("form", { name: "Template" });
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Load reference" }).click();
  await form
    .getByLabel("Text")
    .fill("Update on {{load.reference}} from {{sender.name}}");
  await form.getByRole("button", { name: "Save template" }).click();
  await expect(docs.getByRole("list", { name: "Templates" })).toContainText(
    name,
  );
  // Ask the assistant to draft it for a load.
  const loadRef = (
    await (await page.request.get("/api/loads?status=booked")).json()
  ).loads[0].reference;
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill(`Draft the ${name} for ${loadRef}`);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(/Nothing was sent/)).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp("^Draft: " + name) })
    .click();
  // The draft opens for review, and the missing/reviewed controls are there.
  const sheet = page.getByRole("dialog", { name: "Draft" });
  await expect(sheet.getByLabel("Draft text")).toContainText(loadRef);
  await expect(sheet).toContainText("Written by the assistant");
  await sheet.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Draft" })
      .getByText("Reviewed means a person read it"),
  ).toBeVisible();
});
