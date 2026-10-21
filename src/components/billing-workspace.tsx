"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, ReceiptIcon, FileTextIcon } from "@phosphor-icons/react";
import { Sheet } from "@/components/modal";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type {
  BillingOverview,
  Context,
  DispatchInvoice,
  PaymentState,
} from "@/lib/contracts";
import { stageLabels } from "@/lib/contracts";
import {
  dollarsToMinor,
  feeMinor,
  formatBps,
  formatMoney,
  percentToBps,
} from "@/lib/entry";

const paymentLabels: Record<PaymentState, string> = {
  unpaid: "Unpaid",
  partial: "Partially paid",
  paid: "Paid",
};
const today = () => new Date().toISOString().slice(0, 10);

/** Keeps one retry identity per unchanged form submission. */
/** One stacked fact: a quiet label and a firmer value. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="opsFact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function useRetryKey() {
  const ref = useRef<{ signature: string; key: string } | null>(null);
  return {
    key(signature: string) {
      if (ref.current?.signature !== signature)
        ref.current = { signature, key: crypto.randomUUID() };
      return ref.current.key;
    },
    reset() {
      ref.current = null;
    },
  };
}

type Row = BillingOverview["loads"][number];

function PacketCard({
  row,
  disabled,
  run,
}: {
  row: Row;
  disabled: boolean;
  run: (fn: () => Promise<string>) => Promise<boolean>;
}) {
  const api = useApi();
  const retry = useRetryKey();
  const [mode, setMode] = useState<"" | "edit" | "receipt">("");
  const packet = row.packet;
  return (
    <article
      className="opsCard"
      aria-label={`Freight billing for ${row.reference}`}
    >
      <div className="opsCardHeading">
        <FileTextIcon size={16} aria-hidden="true" />
        <h3>{row.reference}</h3>
        <span className="opsPill">{stageLabels[row.stage]}</span>
        <span className={"opsPill " + (row.documents_ready ? "good" : "warn")}>
          {row.documents_ready ? "Paperwork accepted" : "Paperwork incomplete"}
        </span>
        {packet && (
          <span
            className={
              "opsPill " + (packet.status === "submitted" ? "good" : "")
            }
          >
            {packet.status === "submitted"
              ? "Packet submitted"
              : "Packet draft"}
          </span>
        )}
        {packet?.status === "submitted" && (
          <span
            className={
              "opsPill " + (packet.payment_state === "paid" ? "good" : "warn")
            }
          >
            {paymentLabels[packet.payment_state]}
          </span>
        )}
      </div>
      <dl className="opsFacts">
        <Fact label="Agreed rate" value={formatMoney(row.amount_minor)} />
        {packet && (
          <>
            <Fact
              label="Carrier invoice"
              value={`${packet.carrier_invoice_number} to ${packet.bill_to}`}
            />
            <Fact label="Invoiced" value={formatMoney(packet.amount_minor)} />
            <Fact label="Received" value={formatMoney(packet.paid_minor)} />
          </>
        )}
        {packet?.receipts.map((r) => (
          <Fact
            key={r.id}
            label={`Receipt ${r.received_on}`}
            value={
              formatMoney(r.amount_minor) +
              (r.reference ? ` · ${r.reference}` : "")
            }
          />
        ))}
      </dl>
      {!mode && (
        <div className="opsActions">
          {packet?.status !== "submitted" && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => setMode("edit")}
            >
              {packet ? "Edit packet" : "Prepare packet"}
            </button>
          )}
          {packet?.status === "draft" && (
            <button
              className="secondary"
              disabled={
                disabled || row.stage !== "delivered" || !row.documents_ready
              }
              onClick={() =>
                void run(async () => {
                  await api(`loads/${row.id}/billing-packet/submit`, {
                    version: packet.version,
                  });
                  return `Packet for ${row.reference} marked submitted.`;
                })
              }
            >
              Mark submitted
            </button>
          )}
          {packet?.status === "submitted" &&
            packet.payment_state !== "paid" && (
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => setMode("receipt")}
              >
                Record carrier receipt
              </button>
            )}
        </div>
      )}
      {mode === "edit" && (
        <form
          className="opsForm"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const ok = await run(async () => {
              await api(`loads/${row.id}/billing-packet`, {
                version: packet?.version ?? 0,
                bill_to: String(f.get("bill_to")),
                carrier_invoice_number: String(f.get("number")),
                amount_minor: dollarsToMinor(String(f.get("amount"))),
              });
              return `Packet for ${row.reference} saved.`;
            });
            if (ok) setMode("");
          }}
        >
          <label>
            Bill to (broker or shipper)
            <input
              name="bill_to"
              required
              maxLength={200}
              defaultValue={packet?.bill_to}
            />
          </label>
          <div className="formGrid">
            <label>
              Carrier invoice number
              <input
                name="number"
                required
                maxLength={60}
                defaultValue={packet?.carrier_invoice_number}
              />
            </label>
            <label>
              Amount (USD)
              <input
                name="amount"
                required
                inputMode="decimal"
                defaultValue={formatMoney(
                  packet?.amount_minor ?? row.amount_minor,
                )
                  .slice(1)
                  .replace(/,/g, "")}
              />
            </label>
          </div>
          <div className="opsActions">
            <button className="primary" disabled={disabled}>
              Save packet
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setMode("")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === "receipt" && packet && (
        <form
          className="opsForm"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = {
              amount_minor: dollarsToMinor(String(f.get("amount"))),
              received_on: String(f.get("received_on")),
              reference: String(f.get("reference") || ""),
            };
            const ok = await run(async () => {
              await api(`loads/${row.id}/billing-packet/receipts`, {
                ...body,
                idempotency_key: retry.key(JSON.stringify(body)),
              });
              retry.reset();
              return `Carrier receipt recorded for ${row.reference}.`;
            });
            if (ok) setMode("");
          }}
        >
          <p className="opsMeta">
            Record a payment the carrier reports receiving from {packet.bill_to}
            . Relay does not hold or move freight proceeds.
          </p>
          <div className="formGrid">
            <label>
              Amount received (USD)
              <input name="amount" required inputMode="decimal" />
            </label>
            <label>
              Received on
              <input
                name="received_on"
                type="date"
                required
                defaultValue={today()}
              />
            </label>
          </div>
          <label>
            Reference <small>(optional)</small>
            <input name="reference" maxLength={100} />
          </label>
          <div className="opsActions">
            <button className="primary" disabled={disabled}>
              Record receipt
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setMode("")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function InvoiceCard({
  invoice,
  canInvoice,
  disabled,
  run,
}: {
  invoice: DispatchInvoice;
  canInvoice: boolean;
  disabled: boolean;
  run: (fn: () => Promise<string>) => Promise<boolean>;
}) {
  const api = useApi();
  const retry = useRetryKey();
  const [mode, setMode] = useState<"" | "void" | "payment">("");
  const label = invoice.number || "Draft invoice";
  return (
    <article className="opsCard" aria-label={`Dispatch invoice ${label}`}>
      <div className="opsCardHeading">
        <ReceiptIcon size={16} aria-hidden="true" />
        <h3>{label}</h3>
        <span
          className={
            "opsPill " +
            (invoice.status === "void"
              ? "bad"
              : invoice.status === "issued"
                ? "good"
                : "")
          }
        >
          {invoice.status === "void"
            ? "Void"
            : invoice.status === "issued"
              ? "Issued"
              : "Draft"}
        </span>
        {invoice.payment_state && (
          <span
            className={
              "opsPill " + (invoice.payment_state === "paid" ? "good" : "warn")
            }
          >
            {paymentLabels[invoice.payment_state]}
          </span>
        )}
      </div>
      <dl className="opsFacts">
        <Fact label="Dispatch fee" value={formatBps(invoice.fee_bps)} />
        <Fact label="Total" value={formatMoney(invoice.total_minor)} />
        <Fact label="Paid" value={formatMoney(invoice.paid_minor)} />
        <Fact label="Due" value={invoice.due_on} />
        {invoice.void_reason && (
          <Fact label="Voided" value={invoice.void_reason} />
        )}
      </dl>
      <ul className="opsLines">
        {invoice.lines.map((l) => (
          <li key={l.load_id}>
            {l.reference}: {formatMoney(l.fee_minor)} on{" "}
            {formatMoney(l.load_amount_minor)}
          </li>
        ))}
      </ul>
      {invoice.payments.length > 0 && (
        <dl className="opsFacts">
          {invoice.payments.map((p) => (
            <Fact
              key={p.id}
              label={`Payment ${p.received_on}`}
              value={`${formatMoney(p.amount_minor)} by ${p.method.toUpperCase()}${p.reference ? ` · ${p.reference}` : ""}`}
            />
          ))}
        </dl>
      )}
      {canInvoice && !mode && invoice.status !== "void" && (
        <div className="opsActions">
          {invoice.status === "draft" && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ number: string }>(
                    `dispatch-invoices/${invoice.id}`,
                    {
                      action: "issue",
                      version: invoice.version,
                    },
                  );
                  return `Invoice ${r.number} issued.`;
                })
              }
            >
              Issue invoice
            </button>
          )}
          {invoice.status === "issued" && invoice.payment_state !== "paid" && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => setMode("payment")}
            >
              Record payment
            </button>
          )}
          {invoice.payments.length === 0 && (
            <button
              className="textButton"
              disabled={disabled}
              onClick={() => setMode("void")}
            >
              Void
            </button>
          )}
        </div>
      )}
      {mode === "void" && (
        <form
          className="opsForm"
          onSubmit={async (e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get("reason"));
            const ok = await run(async () => {
              await api(`dispatch-invoices/${invoice.id}`, {
                action: "void",
                version: invoice.version,
                reason,
              });
              return `${label} voided. Its loads can be invoiced again.`;
            });
            if (ok) setMode("");
          }}
        >
          <label>
            Reason for voiding
            <input name="reason" required maxLength={500} />
          </label>
          <div className="opsActions">
            <button className="primary" disabled={disabled}>
              Void invoice
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setMode("")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === "payment" && (
        <form
          className="opsForm"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = {
              amount_minor: dollarsToMinor(String(f.get("amount"))),
              received_on: String(f.get("received_on")),
              method: String(f.get("method")),
              reference: String(f.get("reference") || ""),
            };
            const ok = await run(async () => {
              await api(`dispatch-invoices/${invoice.id}/payments`, {
                ...body,
                idempotency_key: retry.key(JSON.stringify(body)),
              });
              retry.reset();
              return `Payment recorded on ${label}.`;
            });
            if (ok) setMode("");
          }}
        >
          <div className="formGrid">
            <label>
              Amount (USD)
              <input name="amount" required inputMode="decimal" />
            </label>
            <label>
              Received on
              <input
                name="received_on"
                type="date"
                required
                defaultValue={today()}
              />
            </label>
          </div>
          <div className="formGrid">
            <label>
              Method
              <select name="method" defaultValue="ach">
                <option value="ach">ACH</option>
                <option value="check">Check</option>
                <option value="wire">Wire</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Reference <small>(optional)</small>
              <input name="reference" maxLength={100} />
            </label>
          </div>
          <div className="opsActions">
            <button className="primary" disabled={disabled}>
              Record payment
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setMode("")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

type InvoiceFilter =
  | "all"
  | "draft"
  | "open"
  | "overdue"
  | "partial"
  | "paid"
  | "void";
const invoiceFilters: [InvoiceFilter, string][] = [
  ["all", "All"],
  ["draft", "Draft"],
  ["open", "Open"],
  ["overdue", "Overdue"],
  ["partial", "Partly paid"],
  ["paid", "Paid"],
  ["void", "Void"],
];
/** What a person calls an invoice's state, from its status, balance and due date. */
function shownStatus(i: DispatchInvoice, now: string) {
  if (i.status === "draft")
    return { key: "draft" as const, label: "Draft", tone: "" };
  if (i.status === "void")
    return { key: "void" as const, label: "Void", tone: "bad" };
  const balance = BigInt(i.total_minor) - BigInt(i.paid_minor);
  if (balance <= 0n)
    return { key: "paid" as const, label: "Paid", tone: "good" };
  if (i.due_on < now)
    return { key: "overdue" as const, label: "Overdue", tone: "bad" };
  if (BigInt(i.paid_minor) > 0n)
    return { key: "partial" as const, label: "Partly paid", tone: "warn" };
  return { key: "open" as const, label: "Open", tone: "warn" };
}
function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className={"reportTile" + (tone ? " " + tone : "")}>
      <small>{label}</small>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function BillingWorkspace({
  context,
  offline,
  onAuthError,
  query = "",
  onClearQuery,
}: {
  context: Context;
  offline: boolean;
  onAuthError: (e: unknown) => void;
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
}) {
  const api = useApi();
  const carriers = context.carriers.filter((c) => c.role !== "driver");
  const [carrierId, setCarrierId] = useState(carriers[0]?.id || ""),
    [data, setData] = useState<BillingOverview | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [fee, setFee] = useState("8"),
    [allLoads, setAllLoads] = useState(false),
    [tab, setTab] = useState<"invoices" | "freight">("invoices"),
    [filter, setFilter] = useState<InvoiceFilter>("all"),
    [open, setOpen] = useState<
      { kind: "invoice" | "packet"; id: string } | "new" | null
    >(null);
  const retry = useRetryKey();
  const load = useCallback(async () => {
    if (!carrierId) return;
    setBusy(true);
    setError("");
    try {
      setData(await api<BillingOverview>("billing?carrier_id=" + carrierId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }, [api, carrierId, onAuthError]);
  useEffect(() => {
    // Fetch per selected carrier; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      setData(await api<BillingOverview>("billing?carrier_id=" + carrierId));
      setNotice(message);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "SERVICE_UNAVAILABLE",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  const eligible = (data?.loads || []).filter(
    (l) => l.stage === "delivered" && !l.invoice,
  );
  let preview = "";
  try {
    const bps = percentToBps(fee);
    preview = formatMoney(
      eligible
        .filter((l) => selected.includes(l.id))
        .reduce((t, l) => t + BigInt(feeMinor(l.amount_minor, bps)), 0n)
        .toString(),
    );
  } catch {
    preview = "";
  }
  const disabled = busy || offline;
  // Delivered loads and any load with a packet need billing attention.
  const needle = query.trim().toLowerCase();
  const billable = (data?.loads || [])
    .filter((l) => allLoads || l.stage === "delivered" || l.packet)
    .filter(
      (l) =>
        !needle ||
        [l.reference, l.packet?.bill_to, l.packet?.carrier_invoice_number]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  const now = today();
  const invoices = data?.invoices ?? [];
  const money = (n: bigint) => formatMoney(n.toString());
  let outstanding = 0n,
    overdue = 0n,
    collected = 0n,
    overdueCount = 0,
    openCount = 0;
  for (const i of invoices) {
    if (i.status !== "issued") continue;
    const balance = BigInt(i.total_minor) - BigInt(i.paid_minor);
    collected += BigInt(i.paid_minor);
    if (balance <= 0n) continue;
    outstanding += balance;
    openCount++;
    if (i.due_on < now) {
      overdue += balance;
      overdueCount++;
    }
  }
  const shown = invoices
    .filter((i) => filter === "all" || shownStatus(i, now).key === filter)
    .filter(
      (i) =>
        !needle ||
        [i.number ?? "draft", ...(i.lines ?? []).map((l) => l.reference)]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  const counts = (key: InvoiceFilter) =>
    key === "all"
      ? invoices.length
      : invoices.filter((i) => shownStatus(i, now).key === key).length;
  const openInvoice =
    open && open !== "new" && open.kind === "invoice"
      ? invoices.find((i) => i.id === open.id)
      : undefined;
  const openPacket =
    open && open !== "new" && open.kind === "packet"
      ? (data?.loads || []).find((l) => l.id === open.id)
      : undefined;
  return (
    <section
      className="carrierDirectory billing"
      aria-label="Billing and payments"
    >
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Billing and payments</h2>
          <p>
            Invoices Relay sends carriers for dispatch services, and the freight
            bills carriers send brokers. Nothing here sends an invoice or moves
            money.
          </p>
        </div>
        <div className="directoryControls opsFilters">
          {carriers.length > 1 && (
            <label>
              <span className="srOnly">Carrier</span>
              <select
                value={carrierId}
                onChange={(e) => {
                  setCarrierId(e.target.value);
                  setSelected([]);
                  setNotice("");
                  setOpen(null);
                }}
              >
                {carriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {data?.can_invoice && (
            <button
              className="primary"
              disabled={disabled}
              onClick={() => {
                setTab("invoices");
                setOpen("new");
              }}
            >
              <PlusIcon size={15} weight="bold" aria-hidden="true" />
              New invoice
            </button>
          )}
        </div>
      </div>
      {!carriers.length && (
        <p className="helpText">No carrier billing access.</p>
      )}
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice || (busy ? "Loading billing" : "")}
      </p>
      {data && (
        <>
          <div
            className="reportTiles"
            role="group"
            aria-label="Billing summary"
          >
            <Tile
              label="Outstanding"
              value={money(outstanding)}
              hint={`${openCount} open ${openCount === 1 ? "invoice" : "invoices"}`}
            />
            <Tile
              label="Overdue"
              value={money(overdue)}
              hint={`${overdueCount} past due`}
              tone={overdueCount ? "bad" : undefined}
            />
            <Tile
              label="Collected"
              value={money(collected)}
              hint="On issued invoices"
              tone="good"
            />
            <Tile
              label="Ready to invoice"
              value={String(eligible.length)}
              hint={
                eligible.length === 1 ? "delivered load" : "delivered loads"
              }
            />
          </div>
          <div
            className="billingTabs"
            role="tablist"
            aria-label="Billing views"
          >
            {(
              [
                ["invoices", "Invoices", invoices.length],
                ["freight", "Carrier freight", billable.length],
              ] as const
            ).map(([key, label, n]) => (
              <button
                key={key}
                role="tab"
                id={"billing-tab-" + key}
                aria-selected={tab === key}
                aria-controls="billing-panel"
                className="billingTab"
                onClick={() => setTab(key)}
              >
                {label}
                <b>{n}</b>
              </button>
            ))}
          </div>
          <div
            id="billing-panel"
            role="tabpanel"
            aria-labelledby={"billing-tab-" + tab}
          >
            {tab === "invoices" ? (
              <>
                <p className="helpText">
                  Relay&apos;s fee invoices to this carrier under the dispatch
                  agreement.
                </p>
                <div
                  className="attentionChips"
                  role="group"
                  aria-label="Show invoices"
                >
                  {invoiceFilters.map(([key, label]) => {
                    const n = counts(key);
                    if (!n && key !== "all" && filter !== key) return null;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={
                          "attentionChip" + (key === "overdue" ? " late" : "")
                        }
                        aria-pressed={filter === key}
                        onClick={() => setFilter(key)}
                      >
                        {label}
                        <b>{n}</b>
                      </button>
                    );
                  })}
                </div>
                {shown.length ? (
                  <div className="tableScroll billingTable">
                    <table className="reportTable">
                      <caption className="srOnly">Dispatch invoices</caption>
                      <thead>
                        <tr>
                          <th scope="col">Invoice</th>
                          <th scope="col">Status</th>
                          <th scope="col">Due</th>
                          <th scope="col">Total</th>
                          <th scope="col">Paid</th>
                          <th scope="col">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((i) => {
                          const st = shownStatus(i, now);
                          const balance =
                            i.status === "issued"
                              ? BigInt(i.total_minor) - BigInt(i.paid_minor)
                              : 0n;
                          return (
                            <tr key={i.id}>
                              <th scope="row" data-label="Invoice">
                                <button
                                  className="textButton"
                                  onClick={() =>
                                    setOpen({ kind: "invoice", id: i.id })
                                  }
                                  aria-label={`Open invoice ${i.number ?? "draft"}`}
                                >
                                  <ReceiptIcon size={15} aria-hidden="true" />
                                  {i.number ?? "Draft"}
                                </button>
                              </th>
                              <td data-label="Status">
                                <span className={"opsPill " + st.tone}>
                                  {st.label}
                                </span>
                              </td>
                              <td data-label="Due">{i.due_on}</td>
                              <td data-label="Total">
                                {formatMoney(i.total_minor)}
                              </td>
                              <td data-label="Paid">
                                {formatMoney(i.paid_minor)}
                              </td>
                              <td data-label="Balance">
                                <strong>{money(balance)}</strong>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="directoryEmpty">
                    <ReceiptIcon size={32} weight="light" aria-hidden="true" />
                    <h3>
                      {invoices.length
                        ? "No invoices match"
                        : "No dispatch invoices yet"}
                    </h3>
                    <p>
                      {invoices.length
                        ? "Choose another filter."
                        : eligible.length && data.can_invoice
                          ? `${eligible.length} delivered ${eligible.length === 1 ? "load is" : "loads are"} ready to invoice.`
                          : "Invoices appear here once delivered loads are billed."}
                    </p>
                    {invoices.length > 0 && needle && onClearQuery && (
                      <button className="secondary" onClick={onClearQuery}>
                        Clear search
                      </button>
                    )}
                    {!invoices.length &&
                      eligible.length > 0 &&
                      data.can_invoice && (
                        <button
                          className="primary"
                          disabled={disabled}
                          onClick={() => setOpen("new")}
                        >
                          New invoice
                        </button>
                      )}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="helpText">
                  The carrier&apos;s invoice to the broker or shipper. Proceeds
                  belong to the carrier; receipts are recorded as reported.
                </p>
                <label className="setupCheckbox">
                  <input
                    type="checkbox"
                    checked={allLoads}
                    onChange={(e) => setAllLoads(e.target.checked)}
                  />
                  <span>Show loads not yet delivered</span>
                </label>
                {billable.length ? (
                  <div className="tableScroll billingTable">
                    <table className="reportTable">
                      <caption className="srOnly">
                        Carrier freight billing
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Load</th>
                          <th scope="col">Status</th>
                          <th scope="col">Agreed rate</th>
                          <th scope="col">Invoiced</th>
                          <th scope="col">Received</th>
                        </tr>
                      </thead>
                      <tbody>
                        {billable.map((l) => {
                          const pk = l.packet;
                          return (
                            <tr key={l.id}>
                              <th scope="row" data-label="Load">
                                <button
                                  className="textButton"
                                  onClick={() =>
                                    setOpen({ kind: "packet", id: l.id })
                                  }
                                  aria-label={`Open freight billing for ${l.reference}`}
                                >
                                  <FileTextIcon size={15} aria-hidden="true" />
                                  {l.reference}
                                </button>
                              </th>
                              <td data-label="Status">
                                <span
                                  className={
                                    "opsPill " +
                                    (pk?.payment_state === "paid"
                                      ? "good"
                                      : pk?.status === "submitted"
                                        ? "warn"
                                        : "")
                                  }
                                >
                                  {pk
                                    ? pk.status === "submitted"
                                      ? paymentLabels[pk.payment_state]
                                      : "Draft packet"
                                    : l.stage === "delivered"
                                      ? "Needs packet"
                                      : stageLabels[l.stage]}
                                </span>
                              </td>
                              <td data-label="Agreed rate">
                                {formatMoney(l.amount_minor)}
                              </td>
                              <td data-label="Invoiced">
                                {pk ? formatMoney(pk.amount_minor) : "—"}
                              </td>
                              <td data-label="Received">
                                {pk ? formatMoney(pk.paid_minor) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="directoryEmpty">
                    <FileTextIcon size={32} weight="light" aria-hidden="true" />
                    <h3>
                      {allLoads
                        ? "No loads for this carrier yet"
                        : "No delivered loads or packets yet"}
                    </h3>
                  </div>
                )}
              </>
            )}
          </div>
          {open === "new" && data.can_invoice && (
            <Sheet
              label="New dispatch invoice"
              eyebrow="New invoice"
              onClose={() => setOpen(null)}
            >
              <div className="inspectorBody">
                <form
                  className="opsForm"
                  aria-label="Create dispatch invoice"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void run(async () => {
                      const body = {
                        carrier_id: carrierId,
                        load_ids: selected,
                        fee_bps: percentToBps(fee),
                        due_on: String(f.get("due_on")),
                      };
                      await api("dispatch-invoices", {
                        ...body,
                        idempotency_key: retry.key(JSON.stringify(body)),
                      });
                      retry.reset();
                      setSelected([]);
                      setOpen(null);
                      setFilter("all");
                      return "Draft dispatch invoice created. Open it to review, then issue.";
                    });
                  }}
                >
                  <fieldset className="opsChecklist">
                    <legend>Delivered loads not yet invoiced</legend>
                    {eligible.length ? (
                      eligible.map((l) => (
                        <label key={l.id} className="setupCheckbox">
                          <input
                            type="checkbox"
                            checked={selected.includes(l.id)}
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked
                                  ? [...s, l.id]
                                  : s.filter((v) => v !== l.id),
                              )
                            }
                          />
                          <span>
                            {l.reference} · {formatMoney(l.amount_minor)}
                          </span>
                        </label>
                      ))
                    ) : (
                      <small>
                        No delivered loads are waiting for a dispatch invoice.
                      </small>
                    )}
                  </fieldset>
                  <div className="formGrid">
                    <label>
                      Dispatch fee (%)
                      <input
                        value={fee}
                        onChange={(e) => setFee(e.target.value)}
                        inputMode="decimal"
                        required
                      />
                    </label>
                    <label>
                      Due on
                      <input
                        name="due_on"
                        type="date"
                        required
                        defaultValue={now}
                      />
                    </label>
                  </div>
                  {preview && selected.length > 0 && (
                    <small>
                      Invoice total: {preview} (rounded half up per load)
                    </small>
                  )}
                  <div className="opsActions">
                    <button
                      className="primary"
                      disabled={disabled || !selected.length}
                    >
                      Create draft invoice
                    </button>
                    <button
                      type="button"
                      className="textButton"
                      onClick={() => setOpen(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </Sheet>
          )}
          {openInvoice && (
            <Sheet
              label="Invoice"
              eyebrow="Dispatch invoice"
              onClose={() => setOpen(null)}
            >
              <div className="inspectorBody">
                <InvoiceCard
                  invoice={openInvoice}
                  canInvoice={data.can_invoice}
                  disabled={disabled}
                  run={run}
                />
              </div>
            </Sheet>
          )}
          {openPacket && (
            <Sheet
              label="Freight billing"
              eyebrow="Carrier freight billing"
              onClose={() => setOpen(null)}
            >
              <div className="inspectorBody">
                <PacketCard row={openPacket} disabled={disabled} run={run} />
              </div>
            </Sheet>
          )}
        </>
      )}
    </section>
  );
}
