import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool, databaseConnectionString, transaction } from "../../src/lib/db";
import { reportOverview, loadsCsv } from "../../src/lib/reports";
import { listLoads, mutate } from "../../src/lib/loads";
import { listExceptions, openException } from "../../src/lib/exceptions";
import { billingOverview } from "../../src/lib/billing";
import { reviewDocument, uploadDocument } from "../../src/lib/documents";
import {
  messageCapabilities,
  messageResult,
  sendMessage,
} from "../../src/lib/messaging";
import { setTransport } from "../../src/lib/notifications";
import { setSmsTransport } from "../../src/lib/sms";
import { operationsStatus } from "../../src/lib/operations";
import { GET } from "../../src/app/api/[...path]/route";
import {
  sectionAllowed,
  readFilters,
  filterSearch,
} from "../../src/lib/routes";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";
after(() => pool.end());
const params = (carrier: string, extra = "") =>
  new URLSearchParams("carrier_id=" + carrier + extra);

test("report totals, carrier exceptions and exact drill-downs share the UTC pickup cohort", async () => {
  const t = await tenant("RepairScope");
  const inside = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  const outside = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -1500,
  });
  for (const l of [inside, outside])
    await openException(t.dispatcher, l.id, {
      idempotency_key: randomUUID(),
      type: "delay",
      severity: "high",
      summary: "Fictional delay",
    });
  const report = await reportOverview(t.manager, params(t.carrier));
  assert.equal(report.loads.loads, 1);
  assert.equal(report.exceptions.open_now, 1);
  assert.equal(report.carriers[0].open_exceptions, 1);
  const cohort = params(
    t.carrier,
    `&from=${report.range.from}&to=${report.range.to}`,
  );
  assert.deepEqual(
    (await listLoads(t.manager, cohort)).loads.map((l) => l.id),
    [inside.id],
  );
  assert.deepEqual(
    (await listExceptions(t.manager, cohort)).exceptions.map((e) => e.load_id),
    [inside.id],
  );
  await assert.rejects(
    reportOverview(t.manager, params(t.carrier, "&from=2026-02-30")),
    { name: "ZodError" },
  );
  await assert.rejects(
    listLoads(t.manager, params(t.carrier, "&from=2026-03-10&to=2026-03-01")),
    { code: "INVALID_RANGE" },
  );
});

test("accepted historical POD never satisfies a pending or rejected current version", async () => {
  const t = await tenant("RepairPOD");
  const l = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  let version = l.version;
  version = (
    await mutate(t.dispatcher, l.id, "assign", { version, driverId: t.driver })
  ).version;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    version = (
      await mutate(t.dispatcher, l.id, "milestones", { version, stage })
    ).version;
  const upload = () =>
    uploadDocument(
      t.dispatcher,
      {
        carrier_id: t.carrier,
        load_id: l.id,
        type: "pod",
        idempotency_key: randomUUID(),
      },
      { name: "Fictional.pdf", bytes: pdf() },
    );
  const v1 = await upload();
  await reviewDocument(t.dispatcher, v1.version_id, { decision: "accepted" });
  assert.equal(
    (await reportOverview(t.manager, params(t.carrier))).delivered_without_pod,
    0,
  );
  const v2 = await upload();
  const run = async () => {
    const r = await reportOverview(t.manager, params(t.carrier));
    const rows = await listLoads(
      t.manager,
      params(
        t.carrier,
        `&missing_pod=true&from=${r.range.from}&to=${r.range.to}`,
      ),
    );
    assert.equal(r.delivered_without_pod, rows.loads.length);
    return r.delivered_without_pod;
  };
  assert.equal(await run(), 1);
  await reviewDocument(t.dispatcher, v2.version_id, {
    decision: "rejected",
    note: "Fictional rejection",
  });
  assert.equal(await run(), 1);
  const v3 = await upload();
  await reviewDocument(t.dispatcher, v3.version_id, { decision: "accepted" });
  assert.equal(await run(), 0);
});

test("all 137 exceptions remain reachable without duplicates including identical priority timestamps", async () => {
  const t = await tenant("RepairPagination");
  const l = await bookedLoad(t.dispatcher, t.carrier);
  await pool.query(
    `INSERT INTO load_exceptions(id,load_id,carrier_id,type,severity,summary,opened_by,idempotency_key,request_hash)
 SELECT gen_random_uuid(),$1,$2,'delay',CASE WHEN n%3=0 THEN 'high' WHEN n%3=1 THEN 'medium' ELSE 'low' END,'Fictional '||n,$3,gen_random_uuid(),'fixture' FROM generate_series(1,137) n`,
    [l.id, t.carrier, t.dispatcher],
  );
  const first = await listExceptions(t.manager, params(t.carrier));
  assert.equal(first.exceptions.length, 100);
  assert.ok(first.nextCursor);
  const second = await listExceptions(
    t.manager,
    params(t.carrier, "&cursor=" + first.nextCursor),
  );
  assert.equal(second.exceptions.length, 37);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.exceptions, ...second.exceptions].map((x) => x.id)).size,
    137,
  );
  assert.equal(
    (
      await listExceptions(
        t.foreignManager,
        params(t.carrier, "&cursor=" + first.nextCursor),
      )
    ).exceptions.length,
    0,
  );
});

test("billing continues beyond 100 loads without repeated rows", async () => {
  const t = await tenant("RepairBilling");
  await pool.query(
    `INSERT INTO loads(id,carrier_id,reference,source,amount_minor,stage,version)
 SELECT gen_random_uuid(),$1,'REPAIR-'||n,'Fictional QA',10000,'delivered',1 FROM generate_series(1,137) n`,
    [t.carrier],
  );
  const first = await billingOverview(t.manager, params(t.carrier));
  assert.equal(first.loads.length, 100);
  assert.ok(first.loads_cursor);
  const second = await billingOverview(
    t.manager,
    params(t.carrier, "&load_cursor=" + first.loads_cursor),
  );
  assert.equal(second.loads.length, 37);
  assert.equal(second.loads_cursor, null);
  assert.equal(
    new Set([...first.loads, ...second.loads].map((x) => x.id)).size,
    137,
  );
  await assert.rejects(
    billingOverview(
      t.foreignManager,
      params(t.carrier, "&load_cursor=" + first.loads_cursor),
    ),
    { code: "NOT_FOUND" },
  );
});

test("exports include all 5103 records and disclose the actual complete row count", async () => {
  const t = await tenant("RepairExport");
  await pool.query(
    `WITH inserted AS (INSERT INTO loads(id,carrier_id,reference,source,amount_minor,stage,version)
 SELECT gen_random_uuid(),$1,'EXPORT-'||n,'Fictional QA',12345,'booked',1 FROM generate_series(1,5103) n RETURNING id)
 INSERT INTO load_stops(id,load_id,sequence,kind,address,timezone,window_start,window_end)
 SELECT gen_random_uuid(),id,1,'pickup','Fictional Chicago','America/Chicago',now()-interval '1 day',now() FROM inserted`,
    [t.carrier],
  );
  const csv = await loadsCsv(t.manager, params(t.carrier));
  assert.equal(csv.row_count, 5103);
  assert.equal(csv.truncated, false);
  assert.equal(csv.csv.trim().split("\r\n").length, 5104);
  const res = await GET(
    request("reports/loads.csv?" + params(t.carrier), {
      token: await sessionFor(t.manager),
    }),
  );
  assert.equal(res.headers.get("x-relay-row-count"), "5103");
  assert.equal(res.headers.get("x-relay-export-complete"), "true");
});

test("delivery results distinguish queued, provider accepted, failed and unknown; retries never resend", async () => {
  const t = await tenant("RepairMessage");
  process.env.RELAY_DATA_KEY = randomBytes(32).toString("base64");
  setTransport({ name: "fixture", send: async () => "Fictional-provider" });
  const email = await sendMessage(t.manager, {
    mode: "send",
    channel: "email",
    to: ["user:" + t.dispatcher],
    subject: "Fictional repair",
    body: "QA only",
    idempotency_key: randomUUID(),
  });
  assert.equal(email.processingState, "queued");
  assert.equal(email.deliveries[0].status, "queued");
  setTransport(null);
  delete process.env.RELAY_EMAIL_TRANSPORT;
  assert.equal(messageCapabilities().email, false);
  await assert.rejects(
    sendMessage(t.manager, {
      mode: "send",
      channel: "email",
      to: ["user:" + t.dispatcher],
      subject: "Fictional unavailable",
      body: "QA only",
      idempotency_key: randomUUID(),
    }),
    { code: "EMAIL_UNAVAILABLE" },
  );
  await assert.rejects(messageResult(t.foreignManager, email.message_id), {
    code: "NOT_FOUND",
  });
  // SMS requires consent; exercise the existing driver contact identity via a fixture contact.
  const { createContact } = await import("../../src/lib/contacts");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
  const contact = await createContact(t.dispatcher, {
    idempotency_key: randomUUID(),
    organization_id: t.organization,
    kind: "broker",
    name: "Fictional receiver",
    company: "QA",
    email: "",
    phone: "+12145550111",
    notes: "",
    sms_consent: true,
    sms_consent_note: "Fictional fixture consent",
  });
  let attempts = 0;
  for (const state of ["sent", "failed", "unknown"] as const) {
    setSmsTransport({
      name: "fixture",
      send: async () => {
        attempts++;
        return state === "sent"
          ? { ok: true, providerId: "fixture" }
          : {
              ok: false,
              definite: state === "failed",
              error: "Fictional provider response",
            };
      },
    });
    const input = {
      mode: "send",
      channel: "sms",
      to: ["contact:" + contact.id],
      subject: "QA",
      body: "Fictional",
      idempotency_key: randomUUID(),
    };
    const receipt = await sendMessage(t.dispatcher, input);
    assert.equal(receipt.processingState, state);
    const replay = await sendMessage(t.dispatcher, input);
    assert.equal(replay.processingState, state);
  }
  assert.equal(attempts, 3);
  setSmsTransport(undefined);
});

test("membership revocation applies to an active session, exports and message reconciliation", async () => {
  const t = await tenant("RepairRevocation");
  const token = await sessionFor(t.manager);
  assert.equal(
    (await GET(request("reports?" + params(t.carrier), { token }))).status,
    200,
  );
  await pool.query("DELETE FROM memberships WHERE user_id=$1", [t.manager]);
  const response = await GET(
    request("reports?" + params(t.carrier), { token }),
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(
    (await GET(request("reports/loads.csv?" + params(t.carrier), { token })))
      .status,
    404,
  );
  assert.equal(
    sectionAllowed("reports", {
      carriers: [],
      organizations: [{ role: "owner" }],
    }),
    false,
  );
});

test("report read snapshots remain stable across a concurrent committed write", async () => {
  const t = await tenant("RepairSnapshot");
  await transaction(async (c) => {
    const before = Number(
      (
        await c.query("SELECT count(*) n FROM loads WHERE carrier_id=$1", [
          t.carrier,
        ])
      ).rows[0].n,
    );
    await bookedLoad(t.dispatcher, t.carrier);
    assert.equal(
      Number(
        (
          await c.query("SELECT count(*) n FROM loads WHERE carrier_id=$1", [
            t.carrier,
          ])
        ).rows[0].n,
      ),
      before,
    );
  }, "repeatable read");
});

test("URL state is whitelisted and remote PostgreSQL requires validated certificates", () => {
  assert.equal(
    filterSearch(
      readFilters(
        "?from=2026-03-08&to=2026-03-09&missing_pod=true&token=secret&body=private",
      ),
    ),
    "?from=2026-03-08&missing_pod=true&to=2026-03-09",
  );
  assert.equal(
    new URL(
      databaseConnectionString(
        "postgres://qa:fictional@db.example/qa?sslmode=require",
      )!,
    ).searchParams.get("sslmode"),
    "verify-full",
  );
  assert.throws(() =>
    databaseConnectionString("postgres://qa@db.example/qa?sslmode=disable"),
  );
  assert.equal(
    new URL(
      databaseConnectionString("postgres://qa@localhost/qa")!,
    ).searchParams.get("sslmode"),
    null,
  );
});

test("operations metadata is limited to administrators and never returns secret values", async () => {
  const t = await tenant("RepairOperations");
  await assert.rejects(operationsStatus(t.manager), { code: "NOT_FOUND" });
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
  const metadata = await operationsStatus(t.dispatcher);
  // The newest migration the runner knows, so adding one does not break this.
  const { readFileSync } = await import("node:fs");
  const known = [
    ...readFileSync("scripts/migrate.ts", "utf8").matchAll(/\["(\d{3})",/g),
  ].map((m) => m[1]);
  assert.equal(metadata.release.schema.at(-1), known.at(-1));
  assert.ok(!JSON.stringify(metadata).includes(process.env.DATABASE_URL!));
});

test("durable exports survive retries, expire, and refuse downloads after membership revocation", async () => {
  const { createExport, exportStatus, runPendingExports } =
    await import("../../src/lib/report-exports");
  const t = await tenant("RepairDurableExport");
  await bookedLoad(t.dispatcher, t.carrier, { pickupHoursFromNow: -48 });
  const day = new Date().toISOString().slice(0, 10),
    from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const input = { from, to: day, carrier_id: t.carrier, key: randomUUID() };
  const first = await createExport(t.manager, input);
  assert.deepEqual(await createExport(t.manager, input), first);
  await assert.rejects(
    createExport(t.manager, { ...input, from: "2000-01-01" }),
  );
  await runPendingExports(20);
  const ready = await exportStatus(t.manager, first.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.row_count, 1);
  assert.equal(ready.artifact, undefined);
  const download = await GET(
    request("reports/exports/" + first.id + "/download", {
      token: await sessionFor(t.manager),
    }),
  );
  assert.equal(download.status, 200);
  assert.match(await download.text(), /QA-/);
  await assert.rejects(exportStatus(t.foreignManager, first.id), {
    code: "NOT_FOUND",
  });
  await pool.query("DELETE FROM memberships WHERE user_id=$1", [t.manager]);
  await assert.rejects(exportStatus(t.manager, first.id, true), {
    code: "NOT_FOUND",
  });
  await pool.query(
    "UPDATE report_exports SET expires_at=now()-interval '1 second' WHERE id=$1",
    [first.id],
  );
  await runPendingExports(1);
  assert.equal(
    (
      await pool.query("SELECT artifact FROM report_exports WHERE id=$1", [
        first.id,
      ])
    ).rows[0].artifact,
    null,
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      createExport(t.dispatcher, { ...input, key: randomUUID() }),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 3);
  const refused = attempts.find((r) => r.status === "rejected");
  assert.equal(
    refused?.status === "rejected" && refused.reason.code,
    "TRY_AGAIN_LATER",
  );
});

test("invoice drill-down matches issued-date totals and current outstanding balances across carriers", async () => {
  const { reportInvoices } = await import("../../src/lib/report-invoices");
  const t = await tenant("RepairInvoiceCohort");
  await pool.query(
    `INSERT INTO dispatch_invoices(id,carrier_id,number,status,fee_bps,total_minor,due_on,issued_at,issued_by,created_by,idempotency_key,request_hash)
 SELECT gen_random_uuid(),c,'QA-'||gen_random_uuid(),'issued',800,10000,current_date,now(),$2,$2,gen_random_uuid(),'fixture' FROM unnest($1::uuid[]) c`,
    [[t.carrier, t.foreign], t.dispatcher],
  );
  const report = await reportOverview(t.dispatcher, new URLSearchParams());
  const result = await reportInvoices(t.dispatcher, new URLSearchParams());
  assert.equal(result.invoices.length, report.dispatch_invoices!.issued);
  assert.equal(
    result.invoices
      .reduce((n, i) => n + BigInt(i.outstanding_minor), 0n)
      .toString(),
    report.dispatch_invoices!.outstanding_minor,
  );
  await assert.rejects(reportInvoices(t.manager, new URLSearchParams()), {
    code: "NOT_FOUND",
  });
});

test("concurrent dispatch-fee payments cannot overpay and successful retries remain idempotent", async () => {
  const { recordInvoicePayment } = await import("../../src/lib/billing");
  const t = await tenant("RepairPaymentRace");
  const id = randomUUID();
  await pool.query(
    `INSERT INTO dispatch_invoices(id,carrier_id,number,status,fee_bps,total_minor,due_on,issued_at,issued_by,created_by,idempotency_key,request_hash)
 VALUES($1,$2,$3,'issued',800,10000,current_date,now(),$4,$4,gen_random_uuid(),'fixture')`,
    [id, t.carrier, "QA-" + randomUUID(), t.dispatcher],
  );
  const inputs = [0, 1].map(() => ({
    amount_minor: 7500,
    received_on: new Date().toISOString().slice(0, 10),
    method: "ach",
    reference: "Fictional reported payment",
    idempotency_key: randomUUID(),
  }));
  const results = await Promise.allSettled(
    inputs.map((input) => recordInvoicePayment(t.dispatcher, id, input)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.equal(
    failure?.status === "rejected" && failure.reason.code,
    "PAYMENT_EXCEEDS_BALANCE",
  );
  const winner = results.findIndex((r) => r.status === "fulfilled");
  await recordInvoicePayment(t.dispatcher, id, inputs[winner]);
  assert.equal(
    (
      await pool.query(
        "SELECT sum(amount_minor)::text amount,count(*)::int n FROM dispatch_invoice_payments WHERE invoice_id=$1",
        [id],
      )
    ).rows[0].amount,
    "7500",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM dispatch_invoice_payments WHERE invoice_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
});
