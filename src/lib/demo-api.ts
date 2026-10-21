import type { CarrierSetup, Load, Context } from "./contracts";
import { ApiError, api as httpApi } from "./client-api";

// This adapter is used only by /demo. It never calls the server or stores a
// password. Shared production components provide the interface and controls.
const storageKey = "relay-current-demo-v1";
type Role = "dispatcher" | "carrier-manager" | "driver";
type Invite = {
  token: string;
  carrier_id: string;
  driver_id: string | null;
  role: Role;
  name: string;
  email: string;
  expires_at: string;
  used: boolean;
};
type State = {
  carriers: CarrierSetup[];
  loads: Load[];
  invites: Invite[];
  requests: Record<string, unknown>;
  viewer: { role: Role; name: string; carrier_id?: string; driver_id?: string };
};
const org = "11111111-1111-4111-8111-111111111111",
  carrier = "22222222-2222-4222-8222-222222222222",
  other = "33333333-3333-4333-8333-333333333333",
  driver = "44444444-4444-4444-8444-444444444444";
const now = () => new Date().toISOString();
function fixtures(): State {
  const agreement = {
    agreement_ref: "Fictional demo agreement",
    effective_at: new Date(Date.now() - 86400000).toISOString(),
    expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
    verified_at: now(),
    current: true,
  };
  const carriers: CarrierSetup[] = [carrier, other].map((id, i) => ({
    carrier: {
      id,
      name: i ? "Prairie Line Logistics" : "Blue Ridge Transport",
      organization_id: org,
      role: "dispatcher",
    },
    profile: {
      contact_name: i ? "Morgan Reed" : "Casey Lane",
      contact_email: i ? "morgan@example.test" : "casey@example.test",
      phone: "",
      usdot: "",
      step: "complete",
      version: 1,
    },
    agreement: { ...agreement },
    drivers: [
      {
        id: i ? "55555555-5555-4555-8555-555555555555" : driver,
        name: i ? "Morgan Reed" : "Jordan Ellis",
        email: i ? "morgan@example.test" : "jordan@example.test",
        onboarding_status: "ready",
        phone: "",
        timezone: "America/Chicago",
      },
    ],
    can_verify: true,
  }));
  const loads: Load[] = ["booked", "dispatched", "picked-up", "delivered"].map(
    (stage, i) => ({
      id: `66666666-6666-4666-8666-66666666666${i}`,
      reference: `RL-10${i + 1}`,
      carrier_id: i % 2 ? other : carrier,
      carrier_name: carriers[i % 2].carrier.name,
      stage: stage as Load["stage"],
      amount_minor: String(245000 + i * 20000),
      pickup: ["Chicago, IL", "Columbus, OH", "Atlanta, GA", "Dallas, TX"][i],
      delivery: ["Nashville, TN", "Charlotte, NC", "Memphis, TN", "Denver, CO"][
        i
      ],
      version: 1,
      created_at: new Date(Date.now() - i * 3600000).toISOString(),
      source: "Fictional interactive demo",
      stops: [
        {
          kind: "pickup",
          address: ["Chicago, IL", "Columbus, OH", "Atlanta, GA", "Dallas, TX"][
            i
          ],
          window_start: new Date(Date.now() + 86400000).toISOString(),
          window_end: new Date(Date.now() + 90000000).toISOString(),
          timezone: "America/Chicago",
        },
        {
          kind: "delivery",
          address: [
            "Nashville, TN",
            "Charlotte, NC",
            "Memphis, TN",
            "Denver, CO",
          ][i],
          window_start: new Date(Date.now() + 172800000).toISOString(),
          window_end: new Date(Date.now() + 176400000).toISOString(),
          timezone: "America/Chicago",
        },
      ],
      assignment: i
        ? {
            name: carriers[i % 2].drivers[0].name,
            driver_id: carriers[i % 2].drivers[0].id,
          }
        : null,
      events: [
        { id: `demo-event-${i}`, type: "load.created", created_at: now() },
      ],
      check_ins: [],
    }),
  );
  loads[2].check_ins = [
    {
      id: "demo-check-in",
      location: "Chattanooga, TN",
      note: "Driver-reported rest stop. Sample observation.",
      source: "manual",
      actor_name: "Alex Morgan",
      observed_at: new Date(Date.now() - 25 * 60000).toISOString(),
      recorded_at: new Date(Date.now() - 20 * 60000).toISOString(),
    },
  ];
  return {
    carriers,
    loads,
    invites: [],
    requests: {},
    viewer: { role: "dispatcher", name: "Alex Morgan" },
  };
}
export function createDemoApi() {
  let state: State;
  try {
    state =
      JSON.parse(localStorage.getItem(storageKey) || "null") || fixtures();
  } catch {
    state = fixtures();
  }
  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* In-memory demo still works if browser storage is unavailable. */
    }
  };
  const allowed = () =>
    state.carriers.filter(
      (c) =>
        state.viewer.role === "dispatcher" ||
        c.carrier.id === (state.viewer.carrier_id || carrier),
    );
  const context = (): Context => ({
    user: { name: state.viewer.name },
    carriers: allowed().map((c) => ({
      id: c.carrier.id,
      name: c.carrier.name,
      role: state.viewer.role,
    })),
    drivers:
      state.viewer.role === "driver"
        ? []
        : allowed().flatMap((c) =>
            c.drivers
              .filter((d) => d.onboarding_status === "ready")
              .map((d) => ({
                id: d.id,
                name: d.name,
                carrier_id: c.carrier.id,
              })),
          ),
    organizations:
      state.viewer.role === "dispatcher"
        ? [{ id: org, name: "Relay demo workspace" }]
        : [],
  });
  const fail = (code: string, status = 422): never => {
    throw new ApiError(status, code);
  };
  const setup = (id: string) =>
    allowed().find((c) => c.carrier.id === id) || fail("NOT_FOUND", 404);
  const writable = (id: string, dispatcher = false) => {
    const c = setup(id);
    if (
      state.viewer.role === "driver" ||
      (dispatcher && state.viewer.role !== "dispatcher")
    )
      fail("NOT_FOUND", 404);
    return c;
  };
  const event = (l: Load, type: string) => {
    l.events = [
      ...(l.events || []),
      { id: crypto.randomUUID(), type, created_at: now() },
    ];
  };
  const implementation = async (
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const url = new URL(path, "https://demo.invalid/");
    const p = url.pathname.split("/").filter(Boolean);
    const data = body as Record<string, unknown>;
    if (path === "me") return context();
    if (p[0] === "loads") {
      const visible = state.loads.filter(
        (l) =>
          allowed().some((c) => c.carrier.id === l.carrier_id) &&
          (state.viewer.role !== "driver" ||
            l.assignment?.driver_id === (state.viewer.driver_id || driver)),
      );
      if (p.length === 1 && !body) {
        const records = visible.filter(
          (l) =>
            (!url.searchParams.get("q") ||
              l.reference
                .toLowerCase()
                .includes(url.searchParams.get("q")!.toLowerCase())) &&
            (!url.searchParams.get("status") ||
              l.stage === url.searchParams.get("status")) &&
            (!url.searchParams.get("carrier_id") ||
              l.carrier_id === url.searchParams.get("carrier_id")),
        );
        const offset = Number(url.searchParams.get("cursor") || 0);
        return {
          loads: records.slice(offset, offset + 25),
          nextCursor: records.length > offset + 25 ? String(offset + 25) : null,
        };
      }
      if (p.length === 1 && data) {
        const c = writable(String(data.carrierId));
        if (!c.agreement?.current) fail("CARRIER_AUTHORIZATION_REQUIRED");
        if (
          state.loads.some(
            (l) =>
              l.carrier_id === data.carrierId && l.reference === data.reference,
          )
        )
          fail("DUPLICATE_REFERENCE", 409);
        const stops = data.stops as {
          kind: string;
          address: string;
          timezone: string;
          windowStart: string;
          windowEnd: string;
        }[];
        const l: Load = {
          id: crypto.randomUUID(),
          reference: String(data.reference),
          carrier_id: c.carrier.id,
          carrier_name: c.carrier.name,
          stage: "booked",
          amount_minor: String(data.amountMinor),
          pickup: stops[0].address,
          delivery: stops[1].address,
          version: 1,
          created_at: now(),
          source: String(data.source),
          stops: stops.map((s) => ({
            kind: s.kind,
            address: s.address,
            timezone: s.timezone,
            window_start: s.windowStart,
            window_end: s.windowEnd,
          })),
          events: [],
          assignment: null,
          check_ins: [],
        };
        event(l, "load.created");
        state.loads.unshift(l);
        return l;
      }
      const l = visible.find((v) => v.id === p[1]) || fail("NOT_FOUND", 404);
      if (!body) return l;
      if (l.version !== data?.version) fail("VERSION_CONFLICT", 409);
      if (p[2] === "check-ins") {
        l.check_ins = [
          ...(l.check_ins || []),
          {
            id: crypto.randomUUID(),
            location: String(data.location),
            note: String(data.note || ""),
            observed_at: String(data.observed_at),
            recorded_at: now(),
            actor_name: state.viewer.name,
            source: "manual" as const,
          },
        ].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
        event(l, "load.check-in");
      } else {
        const c = writable(l.carrier_id);
        if (p[2] === "assign") {
          if (!c.agreement?.current) fail("CARRIER_AUTHORIZATION_REQUIRED");
          const d =
            c.drivers.find(
              (d) => d.id === data.driverId && d.onboarding_status === "ready",
            ) || fail("DRIVER_CARRIER_MISMATCH");
          l.assignment = { name: d.name, driver_id: d.id };
          event(l, "load.assign");
        } else if (p[2] === "milestones") {
          if (!l.assignment) fail("ASSIGN_DRIVER_FIRST");
          l.stage = data.stage as Load["stage"];
          event(l, "load.milestones");
        }
      }
      l.version++;
      return { id: l.id, version: l.version };
    }
    if (p[0] === "onboarding" && p[1] === "invitations" && data) {
      const invitation =
        state.invites.find(
          (i) =>
            i.token === data.token &&
            !i.used &&
            Date.parse(i.expires_at) > Date.now(),
        ) || fail("INVITE_UNAVAILABLE", 410);
      const c = state.carriers.find(
        (c) => c.carrier.id === invitation.carrier_id,
      )!;
      if (p[2] === "inspect")
        return {
          ...invitation,
          carrier_name: c.carrier.name,
          account_exists: false,
          signed_in: false,
        };
      if (p[2] === "accept") {
        invitation.used = true;
        state.viewer = {
          role: invitation.role,
          name: String(data.name),
          carrier_id: c.carrier.id,
          driver_id: invitation.driver_id || undefined,
        };
        const d = c.drivers.find((d) => d.id === invitation.driver_id);
        if (d) {
          d.name = String(data.name);
          d.onboarding_status = "ready";
        }
        return { ok: true, role: invitation.role };
      }
    }
    if (p[0] === "onboarding" && p[1] === "carriers") {
      if (p.length === 2 && data) {
        if (state.viewer.role !== "dispatcher") fail("NOT_FOUND", 404);
        const id = crypto.randomUUID();
        const c: CarrierSetup = {
          carrier: {
            id,
            name: String(data.name),
            organization_id: org,
            role: "dispatcher",
          },
          profile: {
            contact_name: String(data.contact_name),
            contact_email: String(data.contact_email),
            phone: String(data.phone || ""),
            usdot: String(data.usdot || ""),
            step: "agreement",
            version: 1,
          },
          agreement: null,
          drivers: [],
          can_verify: true,
        };
        state.carriers.push(c);
        return { id };
      }
      const c = writable(p[2]);
      if (!body)
        return { ...c, can_verify: state.viewer.role === "dispatcher" };
      if (p[3] === "company") {
        c.carrier.name = String(data!.name);
        c.profile = {
          contact_name: String(data!.contact_name),
          contact_email: String(data!.contact_email),
          phone: String(data!.phone || ""),
          usdot: String(data!.usdot || ""),
          step: c.profile?.step || "team",
          version: (c.profile?.version || 0) + 1,
        };
        return { id: c.carrier.id };
      }
      if (p[3] === "agreement") {
        writable(p[2], true);
        c.agreement = {
          agreement_ref: String(data!.reference),
          effective_at: String(data!.effective_date) + "T00:00:00Z",
          expires_at: new Date(
            Date.parse(String(data!.through_date) + "T00:00:00Z") + 86400000,
          ).toISOString(),
          verified_at: now(),
          current:
            Date.parse(String(data!.effective_date)) <= Date.now() &&
            Date.parse(String(data!.through_date)) + 86400000 > Date.now(),
        };
        if (c.profile) c.profile.step = "team";
        return { id: c.carrier.id };
      }
      if (p[3] === "complete") {
        if (!c.agreement?.current) fail("CARRIER_AUTHORIZATION_REQUIRED");
        if (c.profile) c.profile.step = "complete";
        return { id: c.carrier.id };
      }
      if (p[3] === "manager-invite" || p[3] === "drivers") {
        let person: { id: string | null; name: string; email: string };
        let role: Role = "driver";
        if (p[3] === "manager-invite") {
          writable(p[2], true);
          if (!c.profile) fail("COMPANY_DETAILS_REQUIRED");
          person = {
            id: null,
            name: c.profile!.contact_name,
            email: c.profile!.contact_email,
          };
          role = "carrier-manager";
        } else if (p.length === 6) {
          const d =
            c.drivers.find((d) => d.id === p[4]) || fail("NOT_FOUND", 404);
          person = { id: d.id, name: d.name, email: d.email || "" };
        } else {
          if (c.drivers.some((d) => d.email === data!.email))
            fail("DRIVER_ALREADY_ADDED", 409);
          const d = {
            id: crypto.randomUUID(),
            name: String(data!.name),
            email: String(data!.email),
            phone: "",
            timezone: "UTC",
            onboarding_status: "pending" as const,
          };
          c.drivers.push(d);
          person = d;
        }
        state.invites
          .filter(
            (i) => i.carrier_id === c.carrier.id && i.email === person.email,
          )
          .forEach((i) => {
            i.used = true;
          });
        const invitation: Invite = {
          token: String(data!.token),
          carrier_id: c.carrier.id,
          driver_id: person.id,
          role,
          name: person.name,
          email: person.email,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          used: false,
        };
        state.invites.push(invitation);
        return {
          id: crypto.randomUUID(),
          driver_id: person.id,
          expires_at: invitation.expires_at,
        };
      }
    }
    fail("NOT_FOUND", 404);
  };
  const api: typeof httpApi = async <T>(
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const input = body as Record<string, unknown> | undefined;
    const requestKey = input?.key || input?.idempotency_key || key;
    const signature = requestKey ? path + ":" + requestKey : null;
    if (signature && state.requests[signature])
      return structuredClone(state.requests[signature]) as T;
    const result = await implementation(path, body);
    if (signature) state.requests[signature] = result;
    persist();
    return structuredClone(result) as T;
  };
  return {
    api,
    get role() {
      return state.viewer.role;
    },
    reset() {
      state = fixtures();
      persist();
    },
    selectRole(role: Role) {
      state.viewer = {
        role,
        name:
          role === "driver"
            ? "Jordan Ellis"
            : role === "carrier-manager"
              ? "Casey Lane"
              : "Alex Morgan",
      };
      persist();
    },
  };
}
