import type {
  BillingPacket,
  CarrierSetup,
  Context,
  DispatchInvoice,
  Load,
} from "./contracts";
import { feeMinor } from "./entry";
import {
  stopTimeError,
  type StopEvent,
  type StopEventKind,
} from "./stop-timing";
import {
  optionalKinds,
  type NotificationLogEntry,
  type OptionalKind,
} from "./notification-kinds";
import {
  carrierDocumentTypes,
  cleanFilename,
  documentStatus,
  driverUploadTypes,
  loadDocumentTypes,
  maxDirectUploadBytes,
  todayUtc,
  type DocumentSlot,
  type DocumentType,
  type DocumentVersion,
} from "./compliance";
import { suggestExceptions, type LoadException } from "./exception-rules";
import { ApiError, api as httpApi } from "./client-api";

// This adapter is used only by /demo. It never calls the server or stores a
// password. Shared production components provide the interface and controls.
const storageKey = "relay-current-demo-v3";
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
// Demo files keep metadata only; file contents never leave the browser and
// are not retained.
type DemoDocument = DocumentVersion & {
  document_id: string;
  carrier_id: string;
  load_id: string | null;
  type: DocumentType;
};
type State = {
  notifications: NotificationLogEntry[];
  preferences: Record<OptionalKind, boolean>;
  packets: Record<string, BillingPacket>;
  invoices: (DispatchInvoice & { carrier_id: string })[];
  exceptions: LoadException[];
  documents: DemoDocument[];
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
          id: `99999999-9999-4999-8999-99999999990${i}`,
          kind: "pickup",
          address: ["Chicago, IL", "Columbus, OH", "Atlanta, GA", "Dallas, TX"][
            i
          ],
          window_start: new Date(Date.now() + 86400000).toISOString(),
          window_end: new Date(Date.now() + 90000000).toISOString(),
          timezone: "America/Chicago",
        },
        {
          id: `99999999-9999-4999-8999-99999999991${i}`,
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
  const documents: DemoDocument[] = [
    {
      id: "77777777-7777-4777-8777-777777777771",
      document_id: "77777777-7777-4777-8777-777777777770",
      carrier_id: loads[3].carrier_id,
      load_id: loads[3].id,
      type: "rate_confirmation",
      version: 1,
      filename: "sample-rate-confirmation.pdf",
      content_type: "application/pdf",
      size_bytes: 48213,
      expires_on: null,
      uploaded_at: now(),
      uploader_name: "Alex Morgan",
      review: {
        decision: "accepted",
        note: "",
        reviewer_name: "Alex Morgan",
        created_at: now(),
      },
    },
  ];
  const exceptions: LoadException[] = [
    {
      id: "88888888-8888-4888-8888-888888888881",
      load_id: loads[2].id,
      carrier_id: loads[2].carrier_id,
      type: "delay",
      severity: "medium",
      status: "open",
      summary: "Driver reports a two-hour weather delay",
      details: "Sample exception for the demo.",
      document_type: null,
      owner_id: null,
      owner_name: null,
      due_at: new Date(Date.now() + 2 * 3600000).toISOString(),
      opened_by_name: "Jordan Ellis",
      opened_at: now(),
      resolved_by_name: null,
      resolved_at: null,
      resolution: null,
      version: 1,
    },
  ];
  return {
    packets: {},
    invoices: [],
    exceptions,
    documents,
    carriers,
    loads,
    invites: [],
    notifications: [],
    preferences: Object.fromEntries(
      optionalKinds.map((k) => [k, true]),
    ) as Record<OptionalKind, boolean>,
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
  const slots = (
    types: readonly DocumentType[],
    match: (d: DemoDocument) => boolean,
  ): DocumentSlot[] =>
    types.map((type) => {
      const history = state.documents
        .filter((d) => d.type === type && match(d))
        .sort((a, b) => b.version - a.version);
      return {
        type,
        document_id: history[0]?.document_id ?? null,
        status: documentStatus(history[0] ?? null, todayUtc()),
        current: history[0] ?? null,
        history: history.slice(0, 10),
      };
    });
  const owners = (carrierId: string) => [
    { id: "demo-dispatcher", name: "Alex Morgan", role: "dispatcher" },
    ...(carrierId === carrier
      ? [{ id: "demo-manager", name: "Casey Lane", role: "carrier-manager" }]
      : []),
  ];
  const withDocuments = (l: Load): Load => {
    const documents = slots(loadDocumentTypes, (d) => d.load_id === l.id);
    const exceptions = state.exceptions.filter((e) => e.load_id === l.id);
    return {
      ...l,
      documents,
      exceptions,
      exception_suggestions: suggestExceptions(
        { stage: l.stage, stops: l.stops, documents, exceptions },
        Date.now(),
      ),
      exception_owners: owners(l.carrier_id),
    };
  };
  const exceptionRequest = (
    path: string[],
    body: Record<string, unknown> | undefined,
    url: URL,
  ) => {
    const visible = (e: LoadException) =>
      state.loads.some(
        (l) =>
          l.id === e.load_id &&
          allowed().some((c) => c.carrier.id === l.carrier_id) &&
          (state.viewer.role !== "driver" ||
            l.assignment?.driver_id === (state.viewer.driver_id || driver)),
      );
    if (path.length === 1 && !body) {
      const status = url.searchParams.get("status") || "active";
      const owner = url.searchParams.get("owner") || "any";
      const me =
        state.viewer.role === "dispatcher" ? "demo-dispatcher" : "demo-manager";
      return {
        exceptions: state.exceptions
          .filter(
            (e) =>
              visible(e) &&
              (status === "all" ||
                (status === "active"
                  ? e.status !== "resolved"
                  : e.status === status)) &&
              (owner === "any" ||
                (owner === "me" ? e.owner_id === me : !e.owner_id)) &&
              (url.searchParams.get("overdue") !== "true" ||
                (e.status !== "resolved" &&
                  !!e.due_at &&
                  Date.parse(e.due_at) < Date.now())),
          )
          .map((e) => {
            const l = state.loads.find((v) => v.id === e.load_id)!;
            return {
              ...e,
              load_reference: l.reference,
              carrier_name: l.carrier_name,
            };
          }),
        truncated: false,
      };
    }
    const e =
      state.exceptions.find((v) => v.id === path[1] && visible(v)) ||
      fail("NOT_FOUND", 404);
    if (state.viewer.role === "driver") fail("NOT_FOUND", 404);
    if (!body || e.version !== body.version) fail("VERSION_CONFLICT", 409);
    const l = state.loads.find((v) => v.id === e.load_id)!;
    const input = body!;
    if (input.action === "assign") {
      if (e.status === "resolved") fail("EXCEPTION_RESOLVED");
      e.owner_id = (input.owner_id as string) || null;
      e.owner_name =
        owners(e.carrier_id).find((o) => o.id === e.owner_id)?.name || null;
      event(l, "exception.assigned");
    } else if (input.action === "start") {
      if (e.status !== "open") fail("INVALID_TRANSITION");
      e.status = "in_progress";
      event(l, "exception.started");
    } else if (input.action === "resolve") {
      if (e.status === "resolved") fail("EXCEPTION_RESOLVED");
      Object.assign(e, {
        status: "resolved",
        resolution: String(input.resolution),
        resolved_at: now(),
        resolved_by_name: state.viewer.name,
      });
      event(l, "exception.resolved");
    } else {
      if (e.status !== "resolved") fail("INVALID_TRANSITION");
      Object.assign(e, {
        status: "open",
        resolution: null,
        resolved_at: null,
        resolved_by_name: null,
      });
      event(l, "exception.reopened");
    }
    e.version++;
    return { id: e.id, version: e.version };
  };
  const documentRequest = (path: string[], body: unknown) => {
    if (path.length === 1 && body instanceof FormData) {
      const field = (name: string) => String(body.get(name) || "");
      const type = field("type") as DocumentType;
      const file = body.get("file");
      if (!(file instanceof File) || !file.size) fail("FILE_REQUIRED", 400);
      const upload = file as File;
      if (upload.size > maxDirectUploadBytes) fail("FILE_TOO_LARGE", 413);
      const loadId = field("load_id") || null;
      if (loadId) {
        const l =
          state.loads.find(
            (v) =>
              v.id === loadId &&
              allowed().some((c) => c.carrier.id === v.carrier_id) &&
              (state.viewer.role !== "driver" ||
                (driverUploadTypes.includes(type) &&
                  v.assignment?.driver_id ===
                    (state.viewer.driver_id || driver))),
          ) || fail("NOT_FOUND", 404);
        event(l, "document.uploaded");
      } else writable(field("carrier_id"));
      const previous = state.documents
        .filter(
          (d) =>
            d.type === type &&
            d.carrier_id === field("carrier_id") &&
            d.load_id === loadId,
        )
        .sort((a, b) => b.version - a.version)[0];
      const version: DemoDocument = {
        id: crypto.randomUUID(),
        document_id: previous?.document_id || crypto.randomUUID(),
        carrier_id: field("carrier_id"),
        load_id: loadId,
        type,
        version: (previous?.version || 0) + 1,
        filename: cleanFilename(upload.name),
        content_type: upload.type || "application/pdf",
        size_bytes: upload.size,
        expires_on: field("expires_on") || null,
        uploaded_at: now(),
        uploader_name: state.viewer.name,
        review: null,
      };
      state.documents.push(version);
      return {
        document_id: version.document_id,
        version_id: version.id,
        version: version.version,
      };
    }
    const target =
      state.documents.find((d) => d.id === path[1]) || fail("NOT_FOUND", 404);
    if (path[2] === "review" && body) {
      writable(target.carrier_id);
      if (state.viewer.role !== "dispatcher")
        fail("DISPATCHER_REVIEW_REQUIRED", 403);
      const input = body as {
        decision: "accepted" | "rejected";
        note?: string;
      };
      target.review = {
        decision: input.decision,
        note: input.note || "",
        reviewer_name: state.viewer.name,
        created_at: now(),
      };
      const l = state.loads.find((v) => v.id === target.load_id);
      if (l) event(l, "document.reviewed");
      return { version_id: target.id, decision: input.decision };
    }
    return fail("NOT_FOUND", 404);
  };
  const paymentState = (total: string, paid: string) =>
    BigInt(paid) >= BigInt(total)
      ? ("paid" as const)
      : BigInt(paid) === 0n
        ? ("unpaid" as const)
        : ("partial" as const);
  const sumMinor = (values: { amount_minor: string }[]) =>
    values.reduce((t, v) => t + BigInt(v.amount_minor), 0n).toString();
  const billingRequest = (
    path: string[],
    body: Record<string, unknown> | undefined,
    url: URL,
  ) => {
    if (path[0] === "billing") {
      const carrierId = url.searchParams.get("carrier_id") || "";
      writable(carrierId);
      return {
        carrier_id: carrierId,
        can_invoice: state.viewer.role === "dispatcher",
        loads: state.loads
          .filter((l) => l.carrier_id === carrierId)
          .map((l) => {
            const docs = withDocuments(l).documents || [];
            const line = state.invoices.find(
              (i) =>
                i.status !== "void" && i.lines.some((x) => x.load_id === l.id),
            );
            return {
              id: l.id,
              reference: l.reference,
              stage: l.stage,
              amount_minor: l.amount_minor,
              documents_ready: docs.every((d) => d.status === "accepted"),
              packet: state.packets[l.id] || null,
              invoice: line
                ? {
                    invoice_id: line.id,
                    number: line.number,
                    status: line.status,
                  }
                : null,
            };
          }),
        invoices: state.invoices.filter((i) => i.carrier_id === carrierId),
      };
    }
    if (path[0] === "dispatch-invoices") {
      if (state.viewer.role !== "dispatcher") fail("DISPATCHER_REQUIRED", 403);
      if (path.length === 1) {
        const ids = body!.load_ids as string[];
        const loads = state.loads.filter((l) => ids.includes(l.id));
        if (loads.some((l) => l.stage !== "delivered"))
          fail("LOAD_NOT_DELIVERED");
        const bps = Number(body!.fee_bps);
        const lines = loads.map((l) => ({
          load_id: l.id,
          reference: l.reference,
          load_amount_minor: l.amount_minor,
          fee_minor: feeMinor(l.amount_minor, bps),
        }));
        const invoice = {
          id: crypto.randomUUID(),
          carrier_id: String(body!.carrier_id),
          number: null,
          status: "draft" as const,
          fee_bps: bps,
          total_minor: lines
            .reduce((t, l) => t + BigInt(l.fee_minor), 0n)
            .toString(),
          due_on: String(body!.due_on),
          issued_at: null,
          void_reason: null,
          version: 1,
          paid_minor: "0",
          payment_state: null,
          lines,
          payments: [],
        };
        state.invoices.unshift(invoice);
        return { id: invoice.id, version: 1 };
      }
      const invoice =
        state.invoices.find((i) => i.id === path[1]) || fail("NOT_FOUND", 404);
      if (path[2] === "payments") {
        if (invoice.status !== "issued") fail("INVOICE_NOT_ISSUED");
        const amount = String(body!.amount_minor);
        if (
          BigInt(invoice.paid_minor) + BigInt(amount) >
          BigInt(invoice.total_minor)
        )
          fail("PAYMENT_EXCEEDS_BALANCE");
        invoice.payments.push({
          id: crypto.randomUUID(),
          amount_minor: amount,
          received_on: String(body!.received_on),
          method: String(body!.method),
          reference: String(body!.reference || ""),
        });
        invoice.paid_minor = sumMinor(invoice.payments);
        invoice.payment_state = paymentState(
          invoice.total_minor,
          invoice.paid_minor,
        );
        return { id: invoice.payments.at(-1)!.id };
      }
      if (invoice.version !== body!.version) fail("VERSION_CONFLICT", 409);
      if (body!.action === "issue") {
        Object.assign(invoice, {
          status: "issued",
          number: "DEMO-" + (1000 + state.invoices.length),
          issued_at: now(),
          payment_state: paymentState(invoice.total_minor, "0"),
        });
      } else {
        if (invoice.payments.length) fail("INVOICE_HAS_PAYMENTS");
        Object.assign(invoice, {
          status: "void",
          void_reason: String(body!.reason),
          payment_state: null,
        });
      }
      invoice.version++;
      return {
        id: invoice.id,
        version: invoice.version,
        number: invoice.number,
      };
    }
    return fail("NOT_FOUND", 404);
  };
  const packetRequest = (
    l: Load,
    path: string[],
    body: Record<string, unknown>,
  ) => {
    if (state.viewer.role === "driver") fail("NOT_FOUND", 404);
    const packet = state.packets[l.id];
    if (path.length === 3) {
      if ((packet?.version ?? 0) !== body.version)
        fail("VERSION_CONFLICT", 409);
      if (packet?.status === "submitted") fail("PACKET_SUBMITTED");
      state.packets[l.id] = {
        bill_to: String(body.bill_to),
        carrier_invoice_number: String(body.carrier_invoice_number),
        amount_minor: String(body.amount_minor),
        status: "draft",
        submitted_at: null,
        version: (packet?.version ?? 0) + 1,
        paid_minor: "0",
        payment_state: "unpaid",
        receipts: [],
      };
      event(l, "billing.packet_saved");
      return { load_id: l.id, version: state.packets[l.id].version };
    }
    if (!packet) return fail("PACKET_REQUIRED");
    if (path[3] === "submit") {
      if (packet.version !== body.version) fail("VERSION_CONFLICT", 409);
      if (l.stage !== "delivered") fail("LOAD_NOT_DELIVERED");
      if (
        (withDocuments(l).documents || []).some((d) => d.status !== "accepted")
      )
        fail("DOCUMENTS_NOT_READY");
      Object.assign(packet, { status: "submitted", submitted_at: now() });
      packet.version++;
      event(l, "billing.packet_submitted");
      return { load_id: l.id, version: packet.version };
    }
    if (packet.status !== "submitted") fail("PACKET_NOT_SUBMITTED");
    const amount = String(body.amount_minor);
    if (
      BigInt(packet.paid_minor) + BigInt(amount) >
      BigInt(packet.amount_minor)
    )
      fail("PAYMENT_EXCEEDS_BALANCE");
    packet.receipts.push({
      id: crypto.randomUUID(),
      amount_minor: amount,
      received_on: String(body.received_on),
      reference: String(body.reference || ""),
    });
    packet.paid_minor = sumMinor(packet.receipts);
    packet.payment_state = paymentState(packet.amount_minor, packet.paid_minor);
    event(l, "billing.carrier_receipt_recorded");
    return { id: packet.receipts.at(-1)!.id };
  };
  const implementation = async (
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const url = new URL(path, "https://demo.invalid/");
    const p = url.pathname.split("/").filter(Boolean);
    const data = body as Record<string, unknown>;
    if (path === "me") return context();
    if (p[0] === "documents") return documentRequest(p, body);
    if (p[0] === "account") {
      if (!body && p.length === 1)
        return {
          name: state.viewer.name,
          email: "demo@example.test",
          email_verified: true,
          mfa_enabled: false,
          mfa_available: false,
          recovery_codes_remaining: 0,
        };
      fail("DEMO_UNAVAILABLE", 409);
    }
    if (p[0] === "carriers" && p[2] === "team" && p[3] === "remove" && data) {
      const c = writable(p[1]);
      const d =
        c.drivers.find((v) => v.id === data.driver_id) ||
        fail("NOT_FOUND", 404);
      if (
        state.loads.some(
          (l) => l.assignment?.driver_id === d.id && l.stage !== "delivered",
        )
      )
        fail("DRIVER_HAS_ACTIVE_LOADS");
      c.drivers = c.drivers.filter((v) => v.id !== d.id);
      return { ok: true };
    }
    if (p[0] === "notifications") {
      if (p[1] === "preferences") {
        if (data) state.preferences[data.kind as OptionalKind] = !!data.email;
        return state.preferences;
      }
      if (!body)
        return { transport: "demo", notifications: state.notifications };
      fail("NOT_FOUND", 404);
    }
    if (p[0] === "exceptions") return exceptionRequest(p, data, url);
    if (p[0] === "billing" || p[0] === "dispatch-invoices")
      return billingRequest(p, data, url);
    if (p[0] === "carriers" && p[2] === "documents" && !body) {
      const c = writable(p[1]);
      const agreementFile = state.documents
        .filter((d) => d.carrier_id === p[1] && d.type === "dispatch_agreement")
        .find((d) => d.review?.decision === "accepted");
      return {
        carrier_id: p[1],
        can_review: state.viewer.role === "dispatcher",
        agreement: c.agreement && {
          ...c.agreement,
          document_version_id: agreementFile?.id ?? null,
        },
        slots: slots(
          carrierDocumentTypes,
          (d) => d.carrier_id === p[1] && !d.load_id,
        ),
      };
    }
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
        if (
          stops.some(
            (stop, i) =>
              i > 0 &&
              Date.parse(stop.windowStart) < Date.parse(stops[i - 1].windowEnd),
          )
        )
          fail("VALIDATION_ERROR", 400);
        const l: Load = {
          id: crypto.randomUUID(),
          reference: String(data.reference),
          carrier_id: c.carrier.id,
          carrier_name: c.carrier.name,
          stage: "booked",
          amount_minor: String(data.amountMinor),
          pickup: stops[0].address,
          delivery: stops[stops.length - 1].address,
          stop_count: stops.length,
          version: 1,
          created_at: now(),
          source: String(data.source),
          stops: stops.map((s) => ({
            id: crypto.randomUUID(),
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
      if (!body) return withDocuments(l);
      if (p[2] === "billing-packet") return packetRequest(l, p, data);
      if (p[2] === "exceptions") {
        if (state.viewer.role === "driver" && (data.owner_id || data.due_at))
          fail("ROLE_NOT_PERMITTED", 403);
        const ownerId = (data.owner_id as string) || null;
        const item: LoadException = {
          id: crypto.randomUUID(),
          load_id: l.id,
          carrier_id: l.carrier_id,
          type: data.type as LoadException["type"],
          severity: data.severity as LoadException["severity"],
          status: "open",
          summary: String(data.summary),
          details: String(data.details || ""),
          document_type:
            (data.document_type as LoadException["document_type"]) || null,
          owner_id: ownerId,
          owner_name:
            owners(l.carrier_id).find((o) => o.id === ownerId)?.name || null,
          due_at: (data.due_at as string) || null,
          opened_by_name: state.viewer.name,
          opened_at: now(),
          resolved_by_name: null,
          resolved_at: null,
          resolution: null,
          version: 1,
        };
        state.exceptions.unshift(item);
        event(l, "exception.opened");
        return { id: item.id, version: 1 };
      }
      if (l.version !== data?.version) fail("VERSION_CONFLICT", 409);
      if (p[2] === "stops" && p[4] === "events") {
        const stops = l.stops || [];
        const index = stops.findIndex((v) => v.id === p[3]);
        if (index < 0) fail("NOT_FOUND", 404);
        const kind = data.kind as StopEventKind;
        const current = stops[index][kind] ?? null;
        if (current && !data.supersedes) fail("STOP_EVENT_EXISTS", 409);
        if (data.supersedes && data.supersedes !== current?.id)
          fail("STOP_EVENT_CHANGED", 409);
        const order = stopTimeError(
          stops,
          index,
          kind,
          String(data.occurred_at),
        );
        if (order) fail(order);
        const entry: StopEvent = {
          id: crypto.randomUUID(),
          kind,
          occurred_at: String(data.occurred_at),
          recorded_at: now(),
          actor_name: state.viewer.name,
          note: String(data.note || ""),
          supersedes: (data.supersedes as string) || null,
          reason: (data.reason as string) || null,
        };
        stops[index] = {
          ...stops[index],
          [kind]: entry,
          stop_events: [...(stops[index].stop_events || []), entry],
        };
        l.version++;
        event(l, `load.stop-${kind}${entry.supersedes ? "-corrected" : ""}`);
        return { id: l.id, version: l.version, stop_event_id: entry.id };
      }
      if (p[2] === "check-ins" && p[4] === "amend") {
        const report =
          (l.check_ins || []).find((r) => r.id === p[3]) ||
          fail("NOT_FOUND", 404);
        if (report.status === "retracted") fail("CHECK_IN_RETRACTED");
        if (state.viewer.role === "driver") fail("ROLE_NOT_PERMITTED", 403);
        report.amendments = [
          ...(report.amendments || []),
          {
            action: data.action as "correct" | "retract",
            reason: String(data.reason),
            actor_name: state.viewer.name,
            created_at: now(),
          },
        ];
        if (data.action === "retract") report.status = "retracted";
        else {
          report.original ??= {
            location: report.location,
            note: report.note,
            observed_at: report.observed_at,
          };
          Object.assign(report, {
            status: "corrected",
            location: String(data.location),
            note: String(data.note || ""),
            observed_at: String(data.observed_at),
          });
        }
        l.version++;
        event(l, "load.check-in-" + String(data.action));
        return { id: l.id, version: l.version, check_in_id: report.id };
      }
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
        const file = state.documents.find(
          (d) => d.id === data!.document_version_id,
        );
        if (file)
          file.review = {
            decision: "accepted",
            note: "",
            reviewer_name: state.viewer.name,
            created_at: now(),
          };
        c.agreement = {
          agreement_ref: String(data!.reference),
          effective_at: String(data!.effective_date) + "T00:00:00Z",
          expires_at: new Date(
            Date.parse(String(data!.through_date) + "T00:00:00Z") + 86400000,
          ).toISOString(),
          verified_at: now(),
          document: file
            ? { version_id: file.id, filename: file.filename }
            : null,
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
        state.notifications.unshift({
          id: crypto.randomUUID(),
          kind: "invitation",
          recipient_email: invitation.email,
          subject: `You're invited to ${c.carrier.name} on Relay`,
          status: "suppressed",
          attempts: 0,
          last_error: "Demo — nothing is sent",
          provider: null,
          created_at: now(),
          sent_at: null,
          next_attempt_at: now(),
          retryable: false,
        });
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
