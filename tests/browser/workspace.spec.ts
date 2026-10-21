import { createRequire } from "node:module";
import { test, expect, type Locator, type Page } from "@playwright/test";
test("authenticated queue, details and mobile layout", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("dispatcher@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("Search reference…").fill("RL-101");
  await expect(
    page.getByRole("button", { name: /^RL-101(?: ·|$)/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^RL-101(?: ·|$)/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Load details" }),
  ).toContainText("Chicago, IL");
  await page.getByRole("button", { name: "Close" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/mobile-workspace.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "artifacts/desktop-workspace.png",
    fullPage: true,
  });
});
test("anonymous API rejected and current demo remains public", async ({
  request,
  page,
}) => {
  const res = await request.get("/api/loads");
  expect(res.status()).toBe(401);
  await page.goto("/demo.html");
  await expect(
    page.getByRole("complementary", { name: "Interactive demo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
});

test("create, assign, dispatch, reject cross-origin writes and revoke session", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("dispatcher@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New load", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create load" });
  const reference = "BROWSER-" + Date.now();
  await modal.getByLabel("Load reference").fill(reference);
  await modal.getByLabel("Booking source").fill("Fictional browser test");
  await modal.getByLabel("Agreed rate").fill("2500.00");
  await modal
    .getByRole("group", { name: "pickup", exact: true })
    .getByLabel("Address")
    .fill("Chicago, IL");
  await modal
    .getByRole("group", { name: "pickup", exact: true })
    .getByLabel("Appointment")
    .fill("2026-11-05T09:00");
  await modal
    .getByRole("group", { name: "delivery", exact: true })
    .getByLabel("Address")
    .fill("Nashville, TN");
  await modal
    .getByRole("group", { name: "delivery", exact: true })
    .getByLabel("Appointment")
    .fill("2026-11-06T09:00");
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal).not.toBeVisible();
  await page.getByPlaceholder("Search reference…").fill(reference);
  await page.getByRole("button", { name: reference, exact: false }).click();
  const details = page.getByRole("dialog", { name: "Load details" });
  await details.getByLabel("Authorized driver").selectOption({ index: 1 });
  await details
    .getByRole("button", { name: "Assign driver", exact: true })
    .click();
  await expect(
    details.locator(".event").filter({ hasText: "Driver assigned" }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Record next milestone" }).click();
  await expect(details.locator(".badge")).toHaveText("Dispatched");
  await expect(
    details.getByRole("button", { name: "Close load details" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(details).not.toBeVisible();
  const rejected = await page.request.post("/api/logout", {
    headers: { Origin: "https://untrusted.example" },
    data: {},
  });
  expect(rejected.status()).toBe(403);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Everything in motion. All in one place.",
    }),
  ).toBeVisible();
  const denied = await page.request.get("/api/loads");
  expect(denied.status()).toBe(401);
});

test("Board, filters, keyboard search and session recovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("carrier@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.locator(".kanban")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "List", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("button", { name: "Filter", exact: false }).click();
  await expect(page.getByLabel("Carrier", { exact: true })).toBeVisible();
  await page
    .getByLabel("Carrier", { exact: true })
    .selectOption({ label: "Blue Ridge Transport" });
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("textbox", { name: "Search loads" }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "Search loads" }).fill("RL-101");
  await expect(
    page.getByRole("button", { name: /^RL-101(?: ·|$)/ }),
  ).toBeVisible();
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "SESSION_EXPIRED" }),
    }),
  );
  await page.getByRole("button", { name: "Refresh loads" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^RL-101(?: ·|$)/ }),
  ).toHaveCount(0);
});

test("lost create response retries with the same idempotency key and exact entry values", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("dispatcher@relay.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await page.getByRole("button", { name: "New load", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create load" }),
    reference = "RETRY-" + Date.now();
  await modal.getByLabel("Load reference").fill(reference);
  await modal.getByLabel("Booking source").fill("Fictional retry test");
  await modal.getByLabel("Agreed rate").fill("2500.01");
  for (const kind of ["pickup", "delivery"]) {
    const group = modal.getByRole("group", { name: kind, exact: true });
    await group
      .getByLabel("Address")
      .fill(kind === "pickup" ? "Chicago, IL" : "New York, NY");
    await group
      .getByLabel("Appointment")
      .fill(kind === "pickup" ? "2026-11-05T09:00" : "2026-11-06T09:00");
    await group
      .getByLabel("Time zone")
      .selectOption(kind === "pickup" ? "America/Chicago" : "America/New_York");
  }
  const keys: string[] = [];
  let first = true;
  await page.route("**/api/loads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal.getByRole("alert")).toBeVisible();
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal).not.toBeVisible();
  expect(keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  const response = await page.request.get("/api/loads?q=" + reference);
  const queue = await response.json();
  expect(queue.loads).toHaveLength(1);
  expect(queue.loads[0].amount_minor).toBe("250001");
  const detail = await (
    await page.request.get("/api/loads/" + queue.loads[0].id)
  ).json();
  expect(detail.stops[0].window_start).toBe("2026-11-05T15:00:00.000Z");
  expect(detail.stops[1].window_start).toBe("2026-11-06T14:00:00.000Z");
});

test("API rejects oversized input and responses prevent caching and framing", async ({
  request,
}) => {
  const oversized = await request.post("/api/login", {
    headers: {
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
    },
    data: JSON.stringify({
      email: "x@relay.test",
      password: "x".repeat(70000),
    }),
  });
  expect(oversized.status()).toBe(413);
  const anonymous = await request.get("/api/loads");
  expect(anonymous.headers()["cache-control"]).toContain("no-store");
  expect(anonymous.headers()["x-frame-options"]).toBe("DENY");
});

for (const [label, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`page headers line up with their content on ${label}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const login = await page.request.post("/api/login", {
      headers: { Origin: "http://localhost:3000" },
      data: {
        email: "dispatcher@relay.test",
        password: process.env.SEED_PASSWORD,
      },
    });
    expect(login.status()).toBe(200);
    await page.goto("/");
    await expect(page.locator(".kanban")).toBeVisible();
    for (const name of ["Inbox", "Carriers", "Billing", "Reports"]) {
      if (label === "phone")
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
      const nav =
        label === "phone"
          ? page.getByRole("dialog", { name: "Workspace navigation" })
          : page.getByRole("navigation").first();
      await nav.getByRole("button", { name, exact: true }).first().click();
      await expect(
        page.getByRole("heading", { name, exact: true, level: 1 }),
      ).toBeVisible();
      const edges = await page.evaluate(() => {
        const main = document.querySelector("main.workspace")!;
        const box = main.getBoundingClientRect();
        const pad = getComputedStyle(main);
        const title = document
          .querySelector("header.topbar h1")!
          .getBoundingClientRect();
        const block = main.firstElementChild!.getBoundingClientRect();
        return {
          contentLeft: box.left + parseFloat(pad.paddingLeft),
          title: title.left,
          block: block.left,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(edges.title, name + " title").toBeCloseTo(edges.contentLeft, 0);
      expect(edges.block, name + " content").toBeCloseTo(edges.contentLeft, 0);
      expect(edges.overflow, name + " overflow").toBe(false);
    }
  });
}

async function signIn(page: Page) {
  const login = await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
}

test("edit and cancel open as drawers lined up with load details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page.locator(".lane.booked .loadCard").first().click();
  const details = page.getByRole("dialog", { name: "Load details" });
  await expect(details).toBeVisible();
  const left = async (dialog: Locator) =>
    dialog.locator(".inspector").evaluate((el) => ({
      x: Math.round(el.getBoundingClientRect().left),
      width: Math.round(el.getBoundingClientRect().width),
      background: getComputedStyle(el).backgroundColor,
    }));
  const base = await left(details);
  for (const name of ["Edit load", "Cancel load"]) {
    await details.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog.locator(".inspector")).toBeVisible();
    const panel = await left(dialog);
    expect(panel.x, name + " left edge").toBe(base.x);
    expect(panel.width, name + " width").toBe(base.width);
    expect(panel.background, name + " is opaque").not.toBe("rgba(0, 0, 0, 0)");
    await dialog
      .getByRole("button", { name: `Close ${name.toLowerCase()}` })
      .click();
    await expect(dialog).toHaveCount(0);
  }
});

test("inbox: tabs filter like an email client and phones get a back button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Inbox", exact: true })
    .first()
    .click();
  await expect(page.locator(".threadItem").first()).toBeVisible();
  await page.locator(".threadItem").first().click();
  const tabs = page.getByRole("group", { name: "Filter conversations" });
  await expect(
    tabs.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await tabs.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(
    tabs.getByRole("button", { name: "Unread", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await tabs.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".threadItem").first()).toBeVisible();
  await page.locator(".threadItem").first().click();
  // The composer stays on screen under a long conversation.
  await expect(page.getByRole("button", { name: "Send" })).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".inboxList")).toBeHidden();
  await page.getByRole("button", { name: "All conversations" }).click();
  await expect(page.locator(".inboxList")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "All conversations" }),
  ).toBeHidden();
});

test("organization: team rows stack cleanly on phones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Workspace navigation" })
    .getByRole("button", { name: "Organization", exact: true })
    .click();
  const row = page.locator(".teamRow:has(.textButton)").first();
  await expect(row).toBeVisible();
  const [name, pills, remove] = await Promise.all(
    [".opsTeamName", ".teamPills", ".textButton"].map(
      async (selector) => (await row.locator(selector).first().boundingBox())!,
    ),
  );
  // Badges sit under the name, Remove stays on the name's line and in view.
  expect(pills.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
  expect(Math.abs(remove.y - name.y)).toBeLessThan(name.height);
  expect(remove.x + remove.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("dropdowns are as wide as their longest option and share a row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Exceptions", exact: true })
    .first()
    .click();
  const selects = page.locator(".workspace select");
  await expect(selects.first()).toBeVisible();
  const widths = await selects.evaluateAll((all) =>
    all.map((select) => {
      const canvas = document.createElement("canvas").getContext("2d")!;
      const style = getComputedStyle(select as HTMLSelectElement);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const widest = Math.max(
        ...[...(select as HTMLSelectElement).options].map(
          (o) => canvas.measureText(o.text).width,
        ),
      );
      const box = select.getBoundingClientRect();
      return { extra: box.width - widest, top: Math.round(box.top) };
    }),
  );
  expect(widths.length).toBeGreaterThan(1);
  for (const { extra } of widths) {
    // Longest option plus padding and the arrow; never stretched to the row.
    expect(extra).toBeGreaterThan(15);
    expect(extra).toBeLessThan(60);
  }
  expect(new Set(widths.map((w) => w.top)).size).toBe(1);
});

// Accessibility guard: WCAG 2 A/AA rules (contrast, names, roles, keyboard
// reach) on the main pages and drawers, at phone and desktop widths.
for (const [label, size] of [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1440, height: 900 }],
] as const) {
  test(`no accessibility violations on the main pages (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await signIn(page);
    await page.goto("/");
    const axe = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
    const scan = async (name: string) => {
      await page.addScriptTag({ path: axe });
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
    };
    const go = async (name: string) => {
      if (label === "phone") {
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Workspace navigation" })
          .getByRole("button", { name: new RegExp(`^${name}`) })
          .first()
          .click();
      } else {
        await page
          .locator(".sidebarDock")
          .getByRole("button", { name: new RegExp(`^${name}`) })
          .first()
          .click();
      }
      await page.waitForTimeout(600);
      await scan(name);
    };
    await scan("Loads");
    for (const name of [
      "Exceptions",
      "Inbox",
      "Contacts",
      "Carriers",
      "Billing",
      "Reports",
    ])
      await go(name);
    await go("Loads");
    await page.locator(".loadCard").first().click();
    await scan("Load details");
  });
}

test("keyboard: Escape closes one dialog at a time and focus returns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const card = page.locator(".lane.booked .loadCard").first();
  const label = await card.getAttribute("aria-label");
  await card.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: "Load details" });
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Edit load", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit load", exact: true });
  await expect(edit).toBeVisible();
  // Escape closes only the top dialog and puts focus back on its button.
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
  await expect(details).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Edit load", exact: true }),
  ).toBeFocused();
  // The second Escape closes the drawer and focus returns to the load card.
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(page.locator(`[aria-label="${label}"]`)).toBeFocused();
});

test("a failed load request says so instead of showing an empty board", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  let failing = true;
  await page.route(/\/api\/loads(\?|$)/, (route) =>
    failing
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "SERVICE_UNAVAILABLE" }),
        })
      : route.continue(),
  );
  await page.goto("/");
  const alert = page.getByRole("alert").filter({ hasText: "couldn't reach" });
  await expect(alert).toBeVisible();
  await expect(page.locator(".toolbarMeta")).toHaveText("Couldn't load");
  await expect(page.locator(".laneEmpty").first()).toHaveText("Couldn't load");
  await expect(page.getByText("No loads here")).toHaveCount(0);
  // Retry brings the board back.
  failing = false;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".loadCard").first()).toBeVisible();
  await expect(alert).toHaveCount(0);
});
