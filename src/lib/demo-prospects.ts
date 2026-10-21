// The browser-only demo of prospects (ADR 0030). It mirrors the server's
// rules so the demo and the app behave alike, but nothing here is saved
// outside this browser and every record is fictional.
import type {
  ActivityKind,
  Prospect,
  ProspectActivity,
  ProspectDetail,
  ProspectList,
  ProspectStage,
} from "./prospect-types";
import { prospectStages } from "./prospect-types";

export type DemoProspect = Prospect & { archived?: boolean };
export type DemoProspects = {
  prospects: DemoProspect[];
  log: Record<string, ProspectActivity[]>;
};
const org = "11111111-1111-4111-8111-111111111111";
export const demoOwner = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Alex Morgan",
};
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function seedProspects(): DemoProspects {
  const make = (
    n: number,
    company: string,
    contact: string,
    stage: ProspectStage,
    over: Partial<Prospect> = {},
  ): DemoProspect => ({
    id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${n}`,
    organization_id: org,
    company,
    contact_name: contact,
    email: contact.split(" ")[0].toLowerCase() + "@example.test",
    phone: "(555) 010-01" + String(40 + n),
    usdot: "",
    truck_count: n + 2,
    source: "referral",
    stage,
    lost_reason: "",
    owner: demoOwner,
    next_follow_up_on: null,
    notes: "Fictional sample prospect.",
    carrier_id: null,
    stage_changed_at: new Date().toISOString(),
    last_activity_at: null,
    version: 1,
    ...over,
  });
  return {
    prospects: [
      make(1, "Cedar Valley Freight", "Jordan Lee", "new", {
        source: "inbound",
        next_follow_up_on: day(0),
      }),
      make(2, "Granite State Haulers", "Sam Rivera", "contacted", {
        next_follow_up_on: day(-2),
      }),
      make(3, "Lone Pine Carriers", "Casey Nguyen", "qualified", {
        source: "load_board",
        next_follow_up_on: day(3),
      }),
      make(4, "Harbor Line Trucking", "Taylor Brooks", "proposal", {
        source: "event",
        owner: null,
      }),
    ],
    log: {},
  };
}

type Host = {
  isStaff: boolean;
  fail: (code: string, status?: number) => never;
  /** Creates the carrier setup record and returns its id. */
  addCarrier: (p: Prospect) => string;
};

export function prospectsRequest(
  store: DemoProspects,
  host: Host,
  path: string[],
  body: Record<string, unknown> | undefined,
  url: URL,
): unknown {
  const { fail } = host;
  if (!host.isStaff) fail("NOT_FOUND", 404);
  const today = day(0);
  const live = () => store.prospects.filter((p) => !p.archived);
  const find = (id: string) =>
    live().find((p) => p.id === id) || fail("NOT_FOUND", 404);
  const entry = (p: Prospect, kind: ProspectActivity["kind"], text: string) => {
    const row: ProspectActivity = {
      id: crypto.randomUUID(),
      kind,
      body: text,
      actor_name: demoOwner.name,
      created_at: new Date().toISOString(),
    };
    (store.log[p.id] ||= []).unshift(row);
    p.last_activity_at = row.created_at;
  };
  const versioned = (p: Prospect) => {
    if (body?.version !== p.version) fail("VERSION_CONFLICT", 409);
  };
  if (path.length === 1 && !body) {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const stage = url.searchParams.get("stage");
    const owner = url.searchParams.get("owner");
    const follow = url.searchParams.get("follow_up");
    const inWeek = (d: string | null) =>
      d !== null && d >= today && d <= day(7);
    const shown = live()
      .filter(
        (p) =>
          (!q ||
            [p.company, p.contact_name, p.email, p.phone, p.usdot]
              .join(" ")
              .toLowerCase()
              .includes(q)) &&
          (!stage || p.stage === stage) &&
          (!owner || p.owner?.id === (owner === "me" ? demoOwner.id : owner)) &&
          (!follow ||
            (follow === "overdue"
              ? p.next_follow_up_on !== null && p.next_follow_up_on < today
              : follow === "today"
                ? p.next_follow_up_on === today
                : inWeek(p.next_follow_up_on))),
      )
      .sort((a, b) =>
        (a.next_follow_up_on ?? "9999").localeCompare(
          b.next_follow_up_on ?? "9999",
        ),
      );
    const open = live().filter((p) => p.stage !== "won" && p.stage !== "lost");
    const counts = Object.fromEntries(
      prospectStages.map((s) => [
        s,
        live().filter((p) => p.stage === s).length,
      ]),
    ) as ProspectList["counts"];
    return {
      prospects: shown,
      counts,
      follow_ups: {
        overdue: open.filter(
          (p) => p.next_follow_up_on !== null && p.next_follow_up_on < today,
        ).length,
        today: open.filter((p) => p.next_follow_up_on === today).length,
        week: open.filter((p) => inWeek(p.next_follow_up_on)).length,
      },
      team: [{ ...demoOwner, organization_id: org }],
      organizations: [{ id: org, name: "Relay demo workspace" }],
      truncated: false,
      today,
    } satisfies ProspectList;
  }
  type Fields = Pick<
    Prospect,
    | "company"
    | "contact_name"
    | "email"
    | "phone"
    | "usdot"
    | "truck_count"
    | "source"
    | "owner"
    | "next_follow_up_on"
    | "notes"
  >;
  const fields = (b: Record<string, unknown>): Fields => {
    const company = String(b.company || "").trim();
    if (!company) fail("VALIDATION_ERROR", 400);
    return {
      company,
      contact_name: String(b.contact_name || "").trim(),
      email: String(b.email || "")
        .trim()
        .toLowerCase(),
      phone: String(b.phone || "").trim(),
      usdot: String(b.usdot || "").trim(),
      truck_count: typeof b.truck_count === "number" ? b.truck_count : null,
      source: (b.source as Prospect["source"]) || "other",
      owner: b.owner_id === demoOwner.id ? demoOwner : null,
      next_follow_up_on: (b.next_follow_up_on as string) || null,
      notes: String(b.notes || "").trim(),
    };
  };
  if (path.length === 1 && body) {
    const p: DemoProspect = {
      id: crypto.randomUUID(),
      organization_id: org,
      lost_reason: "",
      carrier_id: null,
      stage: "new",
      stage_changed_at: new Date().toISOString(),
      last_activity_at: null,
      version: 1,
      ...fields(body),
    };
    store.prospects.push(p);
    return { id: p.id, version: 1 };
  }
  const p = find(path[1]);
  if (path.length === 2 && !body) {
    return {
      prospect: p,
      activities: store.log[p.id] || [],
    } satisfies ProspectDetail;
  }
  if (!body) return fail("NOT_FOUND", 404);
  if (path.length === 2) {
    versioned(p);
    Object.assign(p, fields(body));
    p.version++;
    return { id: p.id, version: p.version };
  }
  if (path[2] === "stage") {
    versioned(p);
    const stage = body.stage as ProspectStage;
    if (!prospectStages.includes(stage)) fail("VALIDATION_ERROR", 400);
    const reason = String(body.lost_reason || "").trim();
    if (stage === "lost" && !reason) fail("VALIDATION_ERROR", 400);
    if (p.carrier_id && stage !== "won") fail("ALREADY_A_CARRIER", 409);
    if (p.stage !== stage) {
      entry(p, "stage", `${p.stage} → ${stage}${reason ? `: ${reason}` : ""}`);
      p.stage = stage;
      p.lost_reason = stage === "lost" ? reason : "";
      p.stage_changed_at = new Date().toISOString();
      if (stage === "won" || stage === "lost") p.next_follow_up_on = null;
      p.version++;
    }
    return { id: p.id, version: p.version };
  }
  if (path[2] === "activities") {
    const kind = body.kind as ActivityKind;
    const text = String(body.body || "").trim();
    if (!["note", "call", "email", "meeting"].includes(kind) || !text)
      fail("VALIDATION_ERROR", 400);
    entry(p, kind, text);
    if (body.next_follow_up_on) {
      p.next_follow_up_on = String(body.next_follow_up_on);
      p.version++;
    }
    return { ok: true, version: p.version };
  }
  if (path[2] === "archive") {
    versioned(p);
    p.archived = true;
    return { ok: true };
  }
  if (path[2] === "convert") {
    if (p.carrier_id) return { carrier_id: p.carrier_id };
    versioned(p);
    if (p.stage === "lost") fail("PROSPECT_LOST", 409);
    if (!p.contact_name || !p.email)
      fail("CONTACT_NAME_AND_EMAIL_REQUIRED", 422);
    p.carrier_id = host.addCarrier(p);
    entry(p, "converted", "Carrier setup started");
    p.stage = "won";
    p.next_follow_up_on = null;
    p.stage_changed_at = new Date().toISOString();
    p.version++;
    return { carrier_id: p.carrier_id };
  }
  return fail("NOT_FOUND", 404);
}
