import { test, expect, type Page } from "@playwright/test";

// These recovery scenarios use only deterministic local route stubs. They do
// not log in, depend on a database, or write application records.
test.use({ viewport: { width: 1440, height: 1000 } });

const carrierId = "11111111-1111-4111-8111-111111111111";
const loadId = "22222222-2222-4222-8222-222222222222";
const context = {
  user: { name: "Recovery QA" },
  carriers: [
    { id: carrierId, name: "Fictional QA Carrier", role: "dispatcher" },
  ],
  drivers: [],
};

function fixture(reference: string) {
  return {
    id: loadId,
    carrier_id: carrierId,
    carrier_name: "Fictional QA Carrier",
    reference,
    stage: "booked",
    amount_minor: "250000",
    pickup: "Chicago, IL",
    delivery: "Nashville, TN",
    created_at: "2026-10-20T10:00:00Z",
    version: 1,
    source: "Fictional recovery test",
    stops: [],
    events: [],
    assignment: null,
  };
}

async function mockContext(page: Page) {
  await page.route("**/api/loads/*/notes", (route) =>
    route.fulfill({ json: { notes: [] } }),
  );
  await page.route("**/api/me", (route) => route.fulfill({ json: context }));
}

async function fillCreateForm(page: Page, reference: string) {
  const modal = page.getByRole("dialog", { name: "Create load" });
  await modal.getByLabel("Load reference").fill(reference);
  await modal.getByLabel("Booking source").fill("Fictional recovery test");
  await modal.getByLabel("Agreed rate").fill("2500.00");
  for (const kind of ["pickup", "delivery"]) {
    const group = modal.getByRole("group", { name: kind, exact: true });
    await group
      .getByLabel("Address")
      .fill(kind === "pickup" ? "Chicago, IL" : "Nashville, TN");
    await group
      .getByLabel("Appointment")
      .fill(kind === "pickup" ? "2026-11-05T09:00" : "2026-11-06T09:00");
  }
  return modal;
}

test("closing a dialog never steals focus from the next input", async ({ page }) => {
  await mockContext(page);
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads: [], nextCursor: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New load", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create load" })).toBeVisible();
  await page.evaluate(() => {
    const qa = window as unknown as {
      restoreFrame: typeof requestAnimationFrame;
      pendingFrames: FrameRequestCallback[];
    };
    qa.restoreFrame = window.requestAnimationFrame;
    qa.pendingFrames = [];
    window.requestAnimationFrame = (callback) => {
      qa.pendingFrames.push(callback);
      return qa.pendingFrames.length;
    };
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Create load" })).toHaveCount(0);
  const search = page.getByRole("searchbox", { name: "Search loads" });
  await search.focus();
  await page.evaluate(() => {
    const qa = window as unknown as {
      restoreFrame: typeof requestAnimationFrame;
      pendingFrames: FrameRequestCallback[];
    };
    window.requestAnimationFrame = qa.restoreFrame;
    for (const callback of qa.pendingFrames) callback(performance.now());
  });
  await expect(search).toBeFocused();
});

test("clearing empty filters and repeating All loads never strand the queue loading", async ({
  page,
}) => {
  await mockContext(page);
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads: [], nextCursor: null } }),
  );
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "Load workspace" });
  const refresh = page.getByRole("button", { name: "Refresh loads" });
  await expect(workspace).toHaveAttribute("aria-busy", "false");

  await expect(workspace).toHaveAttribute("aria-busy", "false");
  await expect(refresh).toBeEnabled();

  const queues = page.getByRole("navigation", { name: "Dispatch queues" });
  for (let i = 0; i < 2; i++) {
    await queues
      .getByRole("button", { name: "All loads", exact: true })
      .click();
    await expect(workspace).toHaveAttribute("aria-busy", "false");
    await expect(refresh).toBeEnabled();
  }
});

test("a pending detail request disables Create and opens only one dialog", async ({
  page,
}) => {
  await mockContext(page);
  const load = fixture("DETAIL-RECOVERY-QA");
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads: [load], nextCursor: null } }),
  );
  let releaseDetail!: () => void;
  let detailStarted!: () => void;
  const pendingDetail = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  const requestedDetail = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  await page.route("**/api/loads/" + loadId, async (route) => {
    detailStarted();
    await pendingDetail;
    await route.fulfill({ json: load });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /DETAIL-RECOVERY-QA/ }).click();
  await requestedDetail;
  try {
    await expect(
      page.getByRole("button", { name: "New load", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  } finally {
    releaseDetail();
  }
  await expect(
    page.getByRole("dialog", { name: "Load details" }),
  ).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Create load" })).toHaveCount(
    0,
  );
});

test("an older initial queue response cannot erase a successfully created load", async ({
  page,
}) => {
  await mockContext(page);
  const load = fixture("NEW-RECOVERY-QA");
  let queueRequests = 0;
  let releaseInitial!: () => void;
  let initialStarted!: () => void;
  let initialSettled!: () => void;
  const pendingInitial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const requestedInitial = new Promise<void>((resolve) => {
    initialStarted = resolve;
  });
  const settledInitial = new Promise<void>((resolve) => {
    initialSettled = resolve;
  });
  await page.route("**/api/loads?*", async (route) => {
    queueRequests++;
    if (queueRequests === 1) {
      initialStarted();
      await pendingInitial;
      try {
        await route.fulfill({ json: { loads: [], nextCursor: null } });
      } finally {
        initialSettled();
      }
    } else {
      await route.fulfill({ json: { loads: [load], nextCursor: null } });
    }
  });
  await page.route("**/api/loads", (route) =>
    route.fulfill({ status: 201, json: load }),
  );

  await page.goto("/");
  await requestedInitial;
  try {
    await page.getByRole("button", { name: "New load", exact: true }).click();
    const modal = await fillCreateForm(page, load.reference);
    await modal.getByRole("button", { name: "Create booked load" }).click();
    await expect(modal).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /NEW-RECOVERY-QA/ }),
    ).toBeVisible();
  } finally {
    releaseInitial();
  }
  await settledInitial;
  // All requests here are local stubs. Settle the deliberately held response
  // before checking that its stale data did not overwrite the newer result.
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: /NEW-RECOVERY-QA/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Load workspace" }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByText("Booked load created.", { exact: true }),
  ).toBeVisible();
});

test("HTML gateway errors produce an actionable queue error instead of parser internals", async ({
  page,
}) => {
  await mockContext(page);
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/html",
      body: "<!DOCTYPE html><html><body>Gateway unavailable</body></html>",
    }),
  );
  await page.goto("/");
  const alert = page
    .getByRole("alert")
    .filter({ hasText: /couldn.t reach Relay/i });
  await expect(alert).toContainText("We couldn't reach Relay just now.");
  await expect(alert).not.toContainText(
    /Unexpected token|SyntaxError|JSON|<!DOCTYPE/i,
  );
  await expect(
    alert.getByRole("button", { name: "Retry", exact: true }),
  ).toBeEnabled();
});

test("a saved load stays acknowledged when the queue refresh fails", async ({
  page,
}) => {
  await mockContext(page);
  const load = fixture("SAVED-REFRESH-QA");
  let saved = false,
    failRefresh = true,
    posts = 0;
  await page.route("**/api/loads?*", (route) =>
    saved && failRefresh
      ? route.fulfill({
          status: 503,
          contentType: "text/html",
          body: "<h1>Temporary gateway failure</h1>",
        })
      : route.fulfill({
          json: { loads: saved ? [load] : [], nextCursor: null },
        }),
  );
  await page.route("**/api/loads", (route) => {
    saved = true;
    posts++;
    return route.fulfill({ status: 201, json: load });
  });
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Load workspace" }),
  ).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "New load", exact: true }).click();
  const modal = await fillCreateForm(page, load.reference);
  await modal.getByRole("button", { name: "Create booked load" }).click();
  await expect(modal).not.toBeVisible();
  await expect(
    page.getByText("Booked load created.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "couldn't reach Relay",
  );
  failRefresh = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /SAVED-REFRESH-QA/ }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("board card names distinguish shared references across carriers", async ({
  page,
}) => {
  const secondCarrier = "33333333-3333-4333-8333-333333333333";
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        ...context,
        carriers: [
          ...context.carriers,
          {
            id: secondCarrier,
            name: "Second Fictional Carrier",
            role: "dispatcher",
          },
        ],
      },
    }),
  );
  const a = fixture("SHARED-QA"),
    b = {
      ...fixture("SHARED-QA"),
      id: "44444444-4444-4444-8444-444444444444",
      carrier_id: secondCarrier,
      carrier_name: "Second Fictional Carrier",
    };
  await page.route("**/api/loads?*", (route) =>
    route.fulfill({ json: { loads: [a, b], nextCursor: null } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: "SHARED-QA · Fictional QA Carrier",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "SHARED-QA · Second Fictional Carrier",
      exact: true,
    }),
  ).toBeVisible();
});

for (const status of [503, 401])
  test(`an older pagination ${status} cannot replace the current filtered queue`, async ({
    page,
  }) => {
    await mockContext(page);
    const old = fixture("OLD-PAGE-QA"),
      current = {
        ...fixture("CURRENT-PAGE-QA"),
        id: "55555555-5555-4555-8555-555555555555",
      };
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      requested = new Promise<void>((resolve) => {
        started = resolve;
      });
    await page.route("**/api/loads?*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.has("cursor")) {
        started();
        await held;
        await route.fulfill({
          status,
          json: {
            error: status === 401 ? "SESSION_EXPIRED" : "SERVICE_UNAVAILABLE",
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          loads: params.get("q") ? [current] : [old],
          nextCursor: params.get("q") ? null : "mock-next-page",
        },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await requested;
    try {
      await page.getByPlaceholder("Search reference…").fill("CURRENT");
      await expect(
        page.getByRole("button", { name: /CURRENT-PAGE-QA/ }),
      ).toBeVisible();
    } finally {
      release();
    }
    await expect(
      page.getByRole("button", { name: "Refresh loads" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /CURRENT-PAGE-QA/ }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  });
