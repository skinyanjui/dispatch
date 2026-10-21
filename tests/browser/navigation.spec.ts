import { test, expect, type Page, type Request } from "@playwright/test";

// Navigation is tested against an explicit fictional membership/queue contract,
// independent of local accounts, secrets, seed data or database availability.
test.use({ viewport: { width: 1440, height: 1000 } });

const carrierA = "11111111-1111-4111-8111-111111111111";
const carrierB = "33333333-3333-4333-8333-333333333333";
const context = {
  user: { name: "Navigation QA" },
  carriers: [
    { id: carrierA, name: "Alpine QA Transport", role: "dispatcher" },
    { id: carrierB, name: "Prairie QA Logistics", role: "carrier-manager" },
  ],
  drivers: [],
};
const loads = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    carrier_id: carrierA,
    carrier_name: "Alpine QA Transport",
    reference: "NAV-A-BOOKED",
    stage: "booked",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    carrier_id: carrierA,
    carrier_name: "Alpine QA Transport",
    reference: "NAV-A-DELIVERED",
    stage: "delivered",
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    carrier_id: carrierB,
    carrier_name: "Prairie QA Logistics",
    reference: "NAV-B-DISPATCHED",
    stage: "dispatched",
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    carrier_id: carrierB,
    carrier_name: "Prairie QA Logistics",
    reference: "NAV-B-TRANSIT",
    stage: "picked-up",
  },
].map((load) => ({
  ...load,
  amount_minor: "250000",
  pickup: "Chicago, IL",
  delivery: "Nashville, TN",
  created_at: "2026-10-20T10:00:00Z",
  source: "Fictional navigation test",
  version: 1,
}));

async function mockWorkspace(page: Page) {
  await page.route("**/api/carriers/summary", (route) =>
    route.fulfill({
      json: {
        generated_at: new Date().toISOString(),
        carriers: context.carriers.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          authorization: {
            state: "current",
            expires_at: "2027-10-21T00:00:00.000Z",
            agreement_ref: "QA",
          },
          loads: { active: 1, total: 1, delivered: 0, cancelled: 0 },
          open_exceptions: 0,
          drivers: 0,
        })),
      },
    }),
  );
  await page.route("**/api/me", (route) => route.fulfill({ json: context }));
  await page.route("**/api/loads?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const selected = loads.filter(
      (load) =>
        (!params.get("status") || load.stage === params.get("status")) &&
        (!params.get("carrier_id") ||
          load.carrier_id === params.get("carrier_id")) &&
        (!params.get("q") ||
          load.reference
            .toLowerCase()
            .includes(params.get("q")!.toLowerCase())),
    );
    return route.fulfill({ json: { loads: selected, nextCursor: null } });
  });
}

function queueRequest(params: Record<string, string>) {
  return (request: Request) => {
    const url = new URL(request.url());
    return (
      request.method() === "GET" &&
      url.pathname === "/api/loads" &&
      Object.entries(params).every(
        ([key, value]) => url.searchParams.get(key) === value,
      )
    );
  };
}

async function expectReady(page: Page) {
  await expect(
    page.getByRole("region", { name: "Load workspace" }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "Refresh loads" }),
  ).toBeEnabled();
}

test("desktop queues send their stage filters and repeated All loads stays ready", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await expectReady(page);
  const queues = page.getByRole("navigation", { name: "Dispatch queues" });

  for (const selection of [
    { label: "Ready to dispatch", status: "booked", reference: "NAV-A-BOOKED" },
    { label: "In transit", status: "picked-up", reference: "NAV-B-TRANSIT" },
  ]) {
    const requested = page.waitForRequest(
      queueRequest({ status: selection.status }),
    );
    await queues
      .getByRole("button", { name: selection.label, exact: true })
      .click();
    await requested;
    await expect(
      page.getByRole("heading", {
        name: selection.label,
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    await expectReady(page);
    await expect(
      page.getByRole("button", { name: new RegExp(selection.reference) }),
    ).toBeVisible();
    await expect(
      queues.getByRole("button", { name: selection.label, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }

  await queues.getByRole("button", { name: "All loads", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
  await expectReady(page);
  for (let i = 0; i < 2; i++) {
    await queues
      .getByRole("button", { name: "All loads", exact: true })
      .click();
    await expectReady(page);
  }
  await expect(
    page.getByRole("button", { name: /NAV-A-BOOKED/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /NAV-B-TRANSIT/ }),
  ).toBeVisible();
});

test("carrier directory reflects membership, supports search and opens carrier-scoped loads", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await expectReady(page);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Carriers", exact: true })
    .click();
  const directory = page.getByRole("region", {
    name: "Authorized carrier directory",
  });
  await expect(directory).toBeVisible();
  await expect(directory.getByRole("article")).toHaveCount(2);
  await expect(
    directory.getByRole("heading", {
      name: "Alpine QA Transport",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    directory.getByRole("heading", {
      name: "Prairie QA Logistics",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    directory.getByText("Dispatcher", { exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByText("Carrier manager", { exact: true }),
  ).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search carriers" });
  await search.fill("Prairie");
  await expect(directory.getByRole("article")).toHaveCount(1);
  await expect(
    directory.getByRole("heading", {
      name: "Alpine QA Transport",
      exact: true,
    }),
  ).toHaveCount(0);
  await search.fill("Not an authorized carrier");
  await expect(
    directory.getByRole("heading", {
      name: "No matching carriers",
      exact: true,
    }),
  ).toBeVisible();
  await directory
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await expect(directory.getByRole("article")).toHaveCount(2);

  const row = directory.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Prairie QA Logistics",
      exact: true,
    }),
  });
  const requested = page.waitForRequest(queueRequest({ carrier_id: carrierB }));
  await row.getByRole("button", { name: "View loads", exact: true }).click();
  const request = await requested;
  const params = new URL(request.url()).searchParams;
  expect(params.has("status")).toBe(false);
  expect(params.has("q")).toBe(false);
  await expectReady(page);
  await expect(
    page.getByRole("heading", { name: "All loads", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /NAV-B-DISPATCHED/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /NAV-B-TRANSIT/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /NAV-A-BOOKED/ })).toHaveCount(
    0,
  );
  await expect(
    page
      .getByRole("navigation", { name: "Carrier scope" })
      .getByRole("button", { name: "Prairie QA Logistics", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("desktop sidebar collapses to icons without duplicating pages and expands again", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await expectReady(page);
  const queues = page.getByRole("navigation", { name: "Dispatch queues" });
  await expect(queues).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  // The queues live above the board, so collapsing the sidebar keeps them.
  await expect(queues).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Dispatch queues" }),
  ).toHaveCount(1);
  // Collapsed, each page is still reachable exactly once by its name.
  const pages = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const name of ["Loads", "Exceptions", "Carriers", "Billing"])
    await expect(pages.getByRole("button", { name, exact: true })).toHaveCount(
      1,
    );
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await expect(queues).toBeVisible();
  for (const name of ["Loads", "Exceptions", "Carriers", "Billing"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      1,
    );
  await expect(
    page.getByRole("button", { name: "Collapse sidebar", exact: true }),
  ).toBeVisible();
  await expectReady(page);
});

test("mobile drawer selects a stage, closes and keeps the document within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page);
  await page.goto("/");
  await expectReady(page);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeVisible();
  // The drawer lists pages only; queues are chips above the board.
  await expect(
    drawer.getByRole("navigation", { name: "Dispatch queues" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const requested = page.waitForRequest(queueRequest({ status: "picked-up" }));
  await page
    .getByRole("navigation", { name: "Dispatch queues" })
    .getByRole("button", { name: "In transit", exact: true })
    .click();
  await requested;
  await expect(
    page.getByRole("heading", { name: "In transit", exact: true, level: 1 }),
  ).toBeVisible();
  await expectReady(page);
  await expect(
    page.getByRole("button", { name: /NAV-B-TRANSIT/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /NAV-A-BOOKED/ })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
