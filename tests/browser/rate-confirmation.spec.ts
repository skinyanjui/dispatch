import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
async function carrierId(page: Page) {
  const me = await (await page.request.get("/api/me")).json();
  return me.carriers.find((c: { name: string }) =>
    c.name.startsWith("Blue Ridge"),
  ).id as string;
}
async function setReading(page: Page, on: boolean) {
  const carrier = await carrierId(page);
  const state = await (
    await page.request.get(
      "/api/rate-confirmations/status?carrier_id=" + carrier,
    )
  ).json();
  const url = `/api/organizations/${state.organization_id}/ai`;
  // Settings are shared and versioned, so re-read and retry on a conflict.
  for (let attempt = 0; attempt < 4; attempt++) {
    const ai = await (await page.request.get(url)).json();
    const res = await page.request.post(url, {
      headers: origin,
      data: {
        version: ai.version,
        enabled: on,
        assistant_enabled: ai.assistant_enabled ?? false,
        monthly_limit_cents: 100000,
      },
    });
    if (res.status() === 409) continue;
    expect(res.status()).toBe(200);
    return;
  }
  throw new Error("settings kept conflicting");
}
const file = (name = "rc.pdf") => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from(
    `%PDF-1.4\n% fictional rate confirmation ${randomUUID()}\n%%EOF\n`,
  ),
});
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

test("a rate confirmation fills the form, a person checks it, and the file becomes the load's rate confirmation", async ({
  page,
}) => {
  await signIn(page);
  await setReading(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "New load" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create load" });
  // One click to choose the file; no separate "read" step.
  await dialog.getByLabel("Rate confirmation file").setInputFiles(file());
  await expect(dialog.getByText(/Filled from rc\.pdf/)).toBeVisible();
  await expect(dialog.getByLabel("Agreed rate (USD)")).toHaveValue("2500.00");
  await expect(dialog.getByLabel("Address").first()).toHaveValue(/Chicago, IL/);
  await expect(dialog.getByLabel("Address").last()).toHaveValue(
    /Nashville, TN/,
  );
  await expect(dialog.getByLabel("Appointment").first()).toHaveValue(/T09:00$/);
  // The things to check are shown next to the fields.
  await expect(
    dialog.getByText(/Time zone guessed from the state/).first(),
  ).toBeVisible();
  await scan(page, "filled create dialog");
  // The person reviews and makes the reference theirs, then creates.
  const reference = "RC-" + randomUUID().slice(0, 8);
  await dialog.getByLabel("Load reference").fill(reference);
  await dialog.getByRole("button", { name: "Create booked load" }).click();
  await expect(dialog).toBeHidden();
  // The load exists with the original file as its rate confirmation.
  const found = await (
    await page.request.get("/api/loads?q=" + reference)
  ).json();
  expect(found.loads).toHaveLength(1);
  const load = await (
    await page.request.get("/api/loads/" + found.loads[0].id)
  ).json();
  const slot = load.documents.find(
    (d: { type: string }) => d.type === "rate_confirmation",
  );
  expect(slot.current.filename).toBe("rc.pdf");
  expect(slot.status).toBe("pending_review");
  // Reading never accepted anything: a person still reviews the document.
  expect(slot.current.review).toBeFalsy();
  await setReading(page, false);
});

test("with AI reading off, an admin gets a button to turn it on", async ({
  page,
}) => {
  await signIn(page);
  await setReading(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "New load" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create load" });
  const turnOn = dialog.getByRole("button", { name: /Turn on AI reading/ });
  await expect(turnOn).toBeVisible();
  await turnOn.click();
  await expect(
    dialog.getByRole("button", { name: "Fill from a rate confirmation" }),
  ).toBeVisible();
  await setReading(page, false);
});

test("a failed reading says so and can be retried; the form stays usable by hand", async ({
  page,
}) => {
  await signIn(page);
  await setReading(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "New load" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create load" });
  await dialog
    .getByLabel("Rate confirmation file")
    .setInputFiles(file("please-fail.pdf"));
  await expect(
    dialog.getByRole("alert").filter({ hasText: "couldn't be read" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(dialog.getByLabel("Load reference")).toBeEditable();
  await setReading(page, false);
});

test("on a phone the dialog fits; in the demo the form fills with labelled sample values", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/demo");
  await page.getByRole("button", { name: "New load" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create load" });
  await dialog.getByLabel("Rate confirmation file").setInputFiles(file());
  await expect(dialog.getByText(/Sample values, no AI used/)).toBeVisible();
  await expect(dialog.getByLabel("Agreed rate (USD)")).toHaveValue("2500.00");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
