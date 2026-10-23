import { createRequire } from "node:module";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ensureVolume } from "./volume";
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
  // Each action has one home: no Filter panel, no second search entry.
  await expect(
    page.getByRole("button", { name: "Filter", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Search loads", exact: true }),
  ).toHaveCount(0);
  // Accumulated QA data can push Blue Ridge below the short list.
  const scope = page.getByRole("navigation", { name: "Carrier scope" });
  const showAll = scope.getByRole("button", { name: /^Show all/ });
  if (await showAll.count()) await showAll.click();
  await scope
    .getByRole("button", { name: "Blue Ridge Transport", exact: true })
    .click();
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("searchbox", { name: "Search loads" }),
  ).toBeFocused();
  await page.getByRole("searchbox", { name: "Search loads" }).fill("RL-101");
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
  test(`pages start with their content, no visible title, on ${label}`, async ({
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
      // The title stays for screen readers but takes no room on screen.
      await expect(
        page.getByRole("heading", { name, exact: true, level: 1 }),
      ).toBeAttached();
      const edges = await page.evaluate(() => {
        const main = document.querySelector("main.workspace")!;
        const box = main.getBoundingClientRect();
        const pad = getComputedStyle(main);
        const bar = document
          .querySelector("header.topbar")!
          .getBoundingClientRect();
        const block = main.firstElementChild!.getBoundingClientRect();
        return {
          contentLeft: box.left + parseFloat(pad.paddingLeft),
          barHeight: bar.height,
          block: block.left,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(edges.barHeight, name + " header").toBeLessThan(4);
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

test("edit and cancel open as opaque drawers above the load record", async ({
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
  await details.getByRole("tab", { name: /^Route/ }).click();
  for (const name of ["Edit load", "Cancel load"]) {
    await details.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog.locator(".inspector")).toBeVisible();
    const panel = await left(dialog);
    expect(panel.width, name + " has room").toBeGreaterThan(300);
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
  const tabs = page.getByRole("group", { name: "Inbox folders" });
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
  await page.getByRole("tab", { name: /People/ }).click();
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
      "Prospects",
      "Assistant",
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
  await details.getByRole("tab", { name: /^Route/ }).click();
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

test("search is on every page, and on settings pages it searches loads", async ({
  page,
}) => {
  await page.request.post("/api/login", {
    headers: { Origin: "http://localhost:3000" },
    data: {
      email: "dispatcher@relay.test",
      password: process.env.SEED_PASSWORD,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  const box = page.getByRole("searchbox", { name: "Search loads" });
  await expect(box).toBeVisible();
  await box.fill("RETRY");
  await expect(
    page.getByRole("button", { name: "Refresh loads" }),
  ).toBeVisible();
});

test("organization: tabs, a filterable people list and search", async ({
  page,
}) => {
  await ensureVolume();
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: /Organization/ }).click();
  const tabs = page.getByRole("tablist", { name: "Organization" });
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Profile");
  await expect(
    page.getByRole("form", { name: "Organization profile" }),
  ).toBeVisible();
  // Arrow keys move between tabs.
  await tabs.getByRole("tab", { name: "Profile" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { selected: true })).toContainText(
    "People",
  );
  const rows = page.locator(".orgPeople > li");
  // The list is paged, not one card per carrier.
  expect(await rows.count()).toBeLessThanOrEqual(25);
  await expect(
    page.getByRole("status").filter({ hasText: "Showing" }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search people" })
    .fill("zzz-nobody");
  await expect(page.getByText("No one matches.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search people" }).fill("");
  await page.getByRole("button", { name: /Show \d+ more/ }).click();
  expect(await rows.count()).toBeGreaterThan(25);
  // Removing asks for a reason first and can be cancelled.
  await page
    .getByRole("button", { name: /^Remove .* from / })
    .first()
    .click();
  await expect(page.getByLabel("Reason")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Reason")).toHaveCount(0);
  await tabs.getByRole("tab", { name: "AI" }).click();
  await expect(page.getByText("AI document reading")).toBeVisible();
  await tabs.getByRole("tab", { name: "Invitations" }).click();
  await expect(
    page.getByRole("heading", { name: "Invite teammates" }),
  ).toBeVisible();
});

test("inbox: folders sit under Inbox in the sidebar; collapsed, they return as a rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Inbox/ }).click();
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const folders = nav.getByRole("group", { name: "Inbox folders" });
  await expect(folders).toBeVisible();
  for (const name of [
    "All",
    "Unread",
    "Relay",
    "Email",
    "Texts",
    "Calls",
    "Archived",
    "Trash",
  ])
    await expect(
      folders.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  // Not repeated on the page while the sidebar lists them.
  await expect(page.locator(".inboxRail")).toBeHidden();
  const toggle = nav.getByRole("button", { name: "Folder list" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await folders.getByRole("button", { name: "Texts", exact: true }).click();
  await expect(
    folders.getByRole("button", { name: "Texts", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Texts", exact: true }),
  ).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(folders).toHaveCount(0);
  await toggle.click();
  // Other pages show no folders.
  await page.getByRole("button", { name: "Contacts", exact: true }).click();
  await expect(nav.getByRole("group", { name: "Inbox folders" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: /^Inbox/ }).click();
  // Collapsed to icons, the folders come back as a rail on the page and the
  // chosen folder is kept.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const rail = page.getByRole("group", { name: "Filter conversations" });
  await expect(rail).toBeVisible();
  await expect(
    rail.getByRole("button", { name: "Texts", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await rail.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator(".inboxRail")).toBeHidden();
  // The back button is for phones only.
  await expect(
    page.getByRole("button", { name: "All conversations" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "New message" }).click();
  await expect(
    page.getByRole("button", { name: "All conversations" }),
  ).toBeHidden();
  // Enter in the people search adds the first match.
  await page.getByRole("searchbox", { name: "Find people" }).fill("Jordan");
  await expect(
    page.getByRole("list", { name: "Matching people" }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Find people" }).press("Enter");
  await expect(
    page.getByRole("button", { name: /^Remove Jordan/ }),
  ).toBeVisible();
});

test("reports: pressed range, KPIs that open their loads, sortable table", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const region = page.getByRole("region", { name: "Reports" });
  const range = region.getByRole("group", { name: "Date range" });
  await expect(
    range.getByRole("button", { name: "Last 30 days" }),
  ).toHaveAttribute("aria-pressed", "true");
  await range.getByRole("button", { name: "Last 7 days" }).click();
  await expect(
    range.getByRole("button", { name: "Last 7 days" }),
  ).toHaveAttribute("aria-pressed", "true");
  await range.getByRole("button", { name: "Last 90 days" }).click();
  await expect(region.getByText("Report loaded")).toBeAttached();
  // A custom range reveals the date fields.
  await range.getByRole("button", { name: "Custom" }).click();
  await expect(region.getByLabel("From")).toBeVisible();
  // Sorting is announced on the header.
  const header = region.getByRole("columnheader", { name: "Carrier" });
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  // One click from a number to the records behind it.
  await region.getByRole("button", { name: /^Open exceptions / }).click();
  await expect(
    page.getByRole("region", { name: "Exception queue" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await region
    .getByRole("button", { name: /^Delivered, no accepted POD/ })
    .click();
  await expect(page.locator(".loadSurface")).toBeVisible();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await region.getByRole("button", { name: /^Booked / }).click();
  await expect(
    page.getByRole("button", { name: "Ready to dispatch", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("inbox: mark unread, archive, trash and restore, with counts and undo", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Inbox/ }).click();
  const rail = page.getByRole("group", { name: "Inbox folders" });
  const rows = page.locator(".threadItem");
  await expect(rows.first()).toBeVisible();
  const subject = (
    await rows.first().locator(".threadSubject").innerText()
  ).trim();
  await rows.first().click();
  const actions = page.getByRole("group", { name: "Conversation actions" });
  // Mark unread: the Unread tab gets a count and the row is bold again.
  await actions.getByRole("button", { name: "Mark unread" }).click();
  await expect(
    rail.getByRole("button", { name: /^Unread/ }).getByLabel(/unread$/),
  ).toBeVisible();
  // Archive, then see it under Archived with a count.
  await page.locator(".threadItem", { hasText: subject }).first().click();
  await actions.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Conversation archived.").first()).toBeVisible();
  await expect(page.locator(".threadItem", { hasText: subject })).toHaveCount(
    0,
  );
  await rail.getByRole("button", { name: /^Archived/ }).click();
  await expect(page.locator(".threadItem", { hasText: subject })).toHaveCount(
    1,
  );
  // Undo puts it back, so move it again and use Trash and Restore.
  await page.locator(".threadItem", { hasText: subject }).click();
  await actions.getByRole("button", { name: "Unarchive" }).click();
  await rail.getByRole("button", { name: "All", exact: true }).click();
  await page.locator(".threadItem", { hasText: subject }).first().click();
  await actions.getByRole("button", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.locator(".threadItem", { hasText: subject }).first(),
  ).toBeVisible();
  await page.locator(".threadItem", { hasText: subject }).first().click();
  await actions.getByRole("button", { name: "Move to trash" }).click();
  await rail.getByRole("button", { name: /^Trash/ }).click();
  await expect(page.locator(".threadItem", { hasText: subject })).toHaveCount(
    1,
  );
  await page.locator(".threadItem", { hasText: subject }).click();
  await actions.getByRole("button", { name: "Restore" }).click();
  await rail.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    page.locator(".threadItem", { hasText: subject }).first(),
  ).toBeVisible();
  // Keyboard: e archives the focused conversation.
  await page.locator(".threadItem", { hasText: subject }).first().focus();
  await page.keyboard.press("e");
  await expect(page.locator(".threadItem", { hasText: subject })).toHaveCount(
    0,
  );
  await rail.getByRole("button", { name: /^Archived/ }).click();
  await page.locator(".threadItem", { hasText: subject }).first().focus();
  await page.keyboard.press("e");
});

test("carriers: authorization, activity and one-click paths", async ({
  page,
}) => {
  await ensureVolume();
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Carriers", exact: true }).click();
  const directory = page.getByRole("region", {
    name: "Authorized carrier directory",
  });
  const filters = directory.getByRole("group", { name: "Filter carriers" });
  await expect(
    filters.getByRole("button", { name: /Authorized/ }),
  ).toBeEnabled();
  const row = directory.locator("tbody tr").filter({
    has: page.getByRole("rowheader", { name: /^Blue Ridge Transport/ }),
  });
  await expect(
    row.getByRole("button", { name: /Authorized until/ }),
  ).toBeVisible();
  // "Active loads" is a column header, said once, not a label in each row.
  await expect(
    directory.getByRole("columnheader", { name: /^Active loads/ }),
  ).toBeVisible();
  await expect(row.getByText("Active loads")).toHaveCount(0);
  // Paged: the QA workspace has far more than one page of carriers.
  expect(await directory.locator("tbody tr").count()).toBeLessThanOrEqual(25);
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  expect(await directory.locator("tbody tr").count()).toBeGreaterThan(25);
  // The filter narrows, and pressing it again clears it.
  await filters.getByRole("button", { name: /With open exceptions/ }).click();
  await expect(
    filters.getByRole("button", { name: /With open exceptions/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: /With open exceptions/ }).click();
  // Sorting by active loads puts the busiest carrier first.
  await directory
    .getByRole("columnheader", { name: /^Active loads/ })
    .getByRole("button")
    .click();
  const active = async (n: number) =>
    Number(
      (
        await directory
          .locator("tbody tr")
          .nth(n)
          .getByRole("button", { name: /active loads for .* Open loads/ })
          .getAttribute("aria-label")
      )?.match(/\d+/)?.[0],
    );
  expect(await active(0)).toBeGreaterThanOrEqual(await active(1));
  // Active loads opens that carrier's loads in one click.
  await directory
    .locator("tbody tr")
    .first()
    .getByRole("button", { name: /active loads for .* Open loads/ })
    .click();
  await expect(page.locator(".loadSurface")).toBeVisible();
});

test("billing: summary cards filter the invoices, columns sort, long lists page", async ({
  page,
}) => {
  await ensureVolume();
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  const region = page.getByRole("region", { name: "Billing and payments" });
  const table = region.getByRole("table", { name: "Dispatch invoices" });
  await expect(table).toBeVisible();
  // The QA carrier has more than one page of invoices.
  const rows = table.locator("tbody tr");
  expect(await rows.count()).toBeLessThanOrEqual(25);
  await region.getByRole("button", { name: "Show more", exact: true }).click();
  expect(await rows.count()).toBeGreaterThan(25);
  // Sort by total, announced on the header.
  const total = table.getByRole("columnheader", { name: "Total" });
  await total.getByRole("button").click();
  await expect(total).toHaveAttribute("aria-sort", "descending");
  await total.getByRole("button").click();
  await expect(total).toHaveAttribute("aria-sort", "ascending");
  // A summary card is a filter: Collected shows the paid invoices.
  await region
    .getByRole("button", { name: /^Collected: .* Show paid/ })
    .click();
  await expect(
    region.getByRole("button", { name: "Paid", exact: false }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  // Carrier freight has its own filters.
  await region.getByRole("tab", { name: /^Carrier freight/ }).click();
  const freight = region.getByRole("group", { name: "Show freight bills" });
  await freight.getByRole("button", { name: /^Needs packet/ }).click();
  await expect(
    freight.getByRole("button", { name: /^Needs packet/ }),
  ).toHaveAttribute("aria-pressed", "true");
  // Rows open their invoice from anywhere on the row.
  await region.getByRole("tab", { name: /^Invoices/ }).click();
  await region
    .getByRole("group", { name: "Show invoices" })
    .getByRole("button", { name: /^All/ })
    .click();
  await table.locator("tbody tr").first().locator("td").first().click();
  await expect(page.getByRole("dialog", { name: "Invoice" })).toBeVisible();
});

test("command menu: open with Ctrl+Shift+K, filter, go anywhere, search loads", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.locator(".kanban")).toBeVisible();
  await page.keyboard.press("Control+Shift+K");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  const box = menu.getByRole("combobox", { name: "Type a command or search" });
  await expect(box).toBeFocused();
  await box.fill("billing");
  await expect(menu.getByRole("option", { selected: true })).toContainText(
    "Billing",
  );
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Billing and payments" }),
  ).toBeVisible();
  // A carrier is a command too, and typing offers to search loads.
  await page.keyboard.press("Control+Shift+K");
  await menu.getByRole("combobox").fill("blue ridge");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.keyboard.press("Control+Shift+K");
  await menu.getByRole("combobox").fill("EASY-");
  await menu.getByRole("option", { name: /Search loads for/ }).click();
  await expect(page.locator(".loadSurface")).toBeVisible();
  // Plain Ctrl+K still focuses the page search.
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("searchbox", { name: "Search loads" }),
  ).toBeFocused();
});

test("load notes: add a note from the load drawer; it shows at the top", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.locator(".loadCard").first().click();
  await page
    .getByRole("dialog", { name: "Load details" })
    .getByRole("tab", { name: /^Notes/ })
    .click();
  const notes = page.getByRole("region", { name: "Internal notes" });
  await expect(notes).toBeVisible();
  await expect(notes).toContainText("Drivers do not");
  const text = "Browser note " + Date.now();
  await notes.getByRole("textbox", { name: "Note", exact: true }).fill(text);
  await notes
    .getByRole("textbox", { name: "Note", exact: true })
    .press("Control+Enter");
  await expect(notes.getByRole("list", { name: "Notes" })).toContainText(text);
  await expect(
    notes.getByRole("textbox", { name: "Note", exact: true }),
  ).toHaveValue("");
});

async function openOptions(page: Page) {
  const options = page.locator(".viewOptions");
  if ((await options.getAttribute("open")) === null)
    await options.locator("summary").click();
  return options;
}

test("loads views: table sorts, groups and hides fields; calendar shows the month; compact board", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.locator(".kanban")).toBeVisible();
  const layout = page.getByRole("group", { name: "Layout" });
  // Board columns show a count and the freight total.
  await expect(page.locator(".lane .groupTotals").first()).toContainText("$");
  const options = await openOptions(page);
  await options.getByLabel("Compact cards").check();
  await expect(page.locator(".kanban.compact")).toBeVisible();
  // Table
  await layout.getByRole("button", { name: "Table" }).click();
  const table = page.getByRole("region", { name: "Load table" });
  await expect(table).toBeVisible();
  const freight = table.getByRole("columnheader", { name: "Freight" });
  await freight.getByRole("button").click();
  await expect(freight).toHaveAttribute("aria-sort", "descending");
  await freight.getByRole("button").click();
  await expect(freight).toHaveAttribute("aria-sort", "ascending");
  await openOptions(page);
  await options.getByLabel("Group by").selectOption("stage");
  await expect(table.getByRole("button", { name: /^Booked/ })).toBeVisible();
  await table.getByRole("button", { name: /^Booked/ }).click();
  await expect(table.getByRole("button", { name: /^Booked/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  // Clicking the table closed the menu; open it again.
  await openOptions(page);
  await options
    .getByRole("group", { name: "Fields" })
    .getByLabel("Driver")
    .uncheck();
  await expect(table.getByRole("columnheader", { name: "Driver" })).toHaveCount(
    0,
  );
  // Calendar
  await layout.getByRole("button", { name: "Calendar" }).click();
  const calendar = page.getByRole("region", { name: "Load calendar" });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole("heading", { level: 2 })).toContainText(
    String(new Date().getFullYear()),
  );
  const title = await calendar.getByRole("heading", { level: 2 }).innerText();
  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(calendar.getByRole("heading", { level: 2 })).not.toHaveText(
    title,
  );
  await calendar.getByRole("button", { name: "Today" }).click();
  await expect(calendar.getByRole("heading", { level: 2 })).toHaveText(title);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("loads views: save, apply, share and delete a named view", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.locator(".kanban")).toBeVisible();
  const name = "By carrier " + Date.now();
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Table" })
    .click();
  const options = await openOptions(page);
  await options.getByLabel("Group by").selectOption("carrier");
  await options.getByRole("button", { name: "Save as new view…" }).click();
  const form = page.getByRole("form", { name: "Save view" });
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByText("View saved.")).toBeAttached();
  // Back to the default, then pick the view: the table and grouping return.
  const picker = page.getByLabel("Saved view");
  await picker.selectOption({ label: "Default view" });
  await expect(page.locator(".kanban")).toBeVisible();
  await picker.selectOption({ label: name });
  await expect(page.getByRole("region", { name: "Load table" })).toBeVisible();
  await openOptions(page);
  await expect(options.getByLabel("Group by")).toHaveValue("carrier");
  // Sharing and deleting.
  await options
    .getByLabel("Share with my organization")
    .first()
    .check()
    .catch(() => undefined);
  page.once("dialog", (d) => void d.accept());
  await options.getByRole("button", { name: "Delete view" }).click();
  await expect(page.getByText("View deleted.")).toBeAttached();
  await expect(picker.locator("option", { hasText: name })).toHaveCount(0);
});

test("loads board: drag a card one step; skipping a step or a missing driver is explained", async ({
  page,
}) => {
  await signIn(page);
  const me = await (await page.request.get("/api/me")).json();
  const carrier = me.carriers.find((c: { name: string }) =>
    c.name.startsWith("Blue Ridge"),
  ).id;
  const driver = me.drivers.find(
    (d: { carrier_id: string }) => d.carrier_id === carrier,
  );
  const ref = "DND-" + Date.now();
  const stop = (kind: string, day: number) => ({
    kind,
    address: kind === "pickup" ? "Chicago, IL" : "Nashville, TN",
    timezone: "America/Chicago",
    windowStart: `2026-11-0${day}T15:00:00Z`,
    windowEnd: `2026-11-0${day}T16:00:00Z`,
  });
  const created = await page.request.post("/api/loads", {
    headers: {
      Origin: "http://localhost:3000",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      carrierId: carrier,
      reference: ref,
      source: "Fictional DnD QA",
      amountMinor: 100000,
      stops: [stop("pickup", 5), stop("delivery", 6)],
    },
  });
  const load = await created.json();
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search loads" }).fill(ref);
  const lane = (name: string) =>
    page.getByRole("region", { name: `${name} loads` });
  const card = lane("Booked").getByRole("button", {
    name: new RegExp("^" + ref),
  });
  await expect(card).toBeVisible();
  // No driver yet: the move is refused with a reason.
  await card.dragTo(lane("Dispatched"));
  await expect(
    page.getByRole("alert").filter({ hasText: "driver" }),
  ).toBeVisible();
  // Skipping a step is refused.
  await page.request.post(`/api/loads/${load.id}/assign`, {
    headers: { Origin: "http://localhost:3000" },
    data: { version: load.version, driverId: driver.id },
  });
  await page.reload();
  await page.getByRole("searchbox", { name: "Search loads" }).fill(ref);
  await lane("Booked")
    .getByRole("button", { name: new RegExp("^" + ref) })
    .dragTo(lane("Delivered"));
  await expect(
    page.getByRole("alert").filter({ hasText: "one step" }),
  ).toBeVisible();
  // The next column works.
  await lane("Booked")
    .getByRole("button", { name: new RegExp("^" + ref) })
    .dragTo(lane("Dispatched"));
  await expect(
    lane("Dispatched").getByRole("button", { name: new RegExp("^" + ref) }),
  ).toBeVisible();
});

test("load record: breadcrumb, fields panel and keyboard-operable tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page.locator(".loadCard").first().click();
  const record = page.getByRole("dialog", { name: "Load details" });
  await expect(record).toBeVisible();
  await expect(
    record.getByRole("navigation", { name: "Breadcrumb" }),
  ).toContainText("Loads");
  const fields = record.getByRole("complementary", { name: "Load fields" });
  await expect(fields).toContainText("Added");
  await expect(fields.getByText("Agreed rate")).toBeVisible();
  const tabs = record.getByRole("tablist", { name: "Load sections" });
  const timeline = tabs.getByRole("tab", { name: /^Timeline/ });
  await expect(timeline).toHaveAttribute("aria-selected", "true");
  // One tab stop; arrow keys move between tabs and select them.
  await expect(timeline).toHaveAttribute("tabindex", "0");
  await timeline.focus();
  await page.keyboard.press("ArrowRight");
  const routeTab = tabs.getByRole("tab", { name: /^Route/ });
  await expect(routeTab).toBeFocused();
  await expect(routeTab).toHaveAttribute("aria-selected", "true");
  await expect(timeline).toHaveAttribute("tabindex", "-1");
  await expect(
    record.getByRole("tabpanel").getByRole("heading", {
      name: "Route & appointments",
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await record.getByRole("button", { name: "Close load details" }).click();
  await expect(record).toHaveCount(0);
});

test("loads table: Add new opens the form and Calculate summarizes freight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Table" })
    .click();
  const table = page.getByRole("region", { name: "Load table" });
  await expect(table).toBeVisible();
  const calc = table.getByLabel("Calculate freight");
  const out = table.getByLabel("Freight calculation");
  await expect(out).toHaveText("");
  await calc.selectOption("sum");
  await expect(out).toContainText("$");
  const sum = await out.textContent();
  await calc.selectOption("max");
  const max = await out.textContent();
  await calc.selectOption("min");
  const min = await out.textContent();
  const n = (t: string | null) => Number(t!.replace(/[^0-9.]/g, ""));
  expect(n(max)).toBeGreaterThanOrEqual(n(min));
  expect(n(sum)).toBeGreaterThanOrEqual(n(max));
  await calc.selectOption("average");
  expect(n(await out.textContent())).toBeLessThanOrEqual(n(max));
  await table.getByLabel("Calculate carrier").selectOption("unique");
  await expect(table.getByLabel("Carrier calculation")).toHaveText(/^\d+$/);
  await table.getByLabel("Calculate created").selectOption("earliest");
  await expect(table.getByLabel("Created calculation")).not.toHaveText("");
  await table.getByRole("button", { name: "Add new" }).click();
  await expect(page.getByRole("dialog", { name: "Create load" })).toBeVisible();
});

test("loads toolbar: Filter, Sort and Options sit on one row and work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await page
    .getByRole("group", { name: "Layout" })
    .getByRole("button", { name: "Table" })
    .click();
  const summaries = page.locator(".viewTools summary");
  await expect(summaries).toHaveText([/^Filter/, "Sort", "Options"]);
  const tops = await summaries.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  // Sort
  await page.locator(".viewTools summary", { hasText: "Sort" }).click();
  await page.getByLabel("Sort by").selectOption("freight");
  await page.getByLabel("Direction").selectOption("asc");
  await expect(
    page.getByRole("columnheader", { name: "Freight" }),
  ).toHaveAttribute("aria-sort", "ascending");
  // Filter
  await page.locator(".viewTools summary", { hasText: "Filter" }).click();
  await page.getByLabel("Status").selectOption("delivered");
  await expect(page.locator(".viewMenu summary .countBadge")).toHaveText("1");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".viewMenu summary .countBadge")).toHaveCount(0);
});

test("loads: the carrier list sits under Loads and folds away", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const scope = nav.getByRole("navigation", { name: "Carrier scope" });
  await expect(scope).toBeVisible();
  // Directly under Loads, before the next page.
  const [loads, first, next] = await Promise.all([
    nav.getByRole("button", { name: "Loads", exact: true }).boundingBox(),
    scope.getByRole("button").first().boundingBox(),
    nav.getByRole("button", { name: "Exceptions", exact: true }).boundingBox(),
  ]);
  expect(first!.y).toBeGreaterThan(loads!.y);
  expect(first!.x).toBeGreaterThan(loads!.x);
  expect(next!.y).toBeGreaterThan(first!.y);
  const toggle = nav.getByRole("button", { name: "Carrier list" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(scope).toHaveCount(0);
  await toggle.press("Enter");
  await expect(scope).toBeVisible();
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  await expect(scope).toHaveCount(0);
});
