"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileTextIcon,
  PlusIcon,
  ReceiptIcon,
} from "@phosphor-icons/react";
import { Sheet } from "@/components/modal";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
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
const pageSize = 25;
const DAY = 86_400_000;
type InvoiceSort = "number" | "due" | "total" | "balance";
type FreightFilter = "all" | "needs-packet" | "submitted" | "paid";
const freightFilters: [FreightFilter, string][] = [
  ["all", "All"],
  ["needs-packet", "Needs packet"],
  ["submitted", "Submitted"],
  ["paid", "Paid"],
];
/** "3 days overdue", "due today", "due in 5 days"; nothing once settled. */
function aging(due: string, now: string, settled: boolean) {
  if (settled) return "";
  const days = Math.round((Date.parse(due) - Date.parse(now)) / DAY);
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} day${days === 1 ? "" : "s"}`;
}
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

export function BillingWorkspace({
  context,
  offline,
  onAuthError,
  query = "",
  onClearQuery,
  invoiceId = null,
  onInvoiceChange,
}: {
  context: Context;
  offline: boolean;
  onAuthError: (e: unknown) => void;
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
  /** The invoice the address names; opened once its carrier's list loads. */
  invoiceId?: string | null;
  /** Told when a person opens or closes an invoice, so the address follows. */
  onInvoiceChange?: (id: string | null) => void;
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
    [freightFilter, setFreightFilter] = useState<FreightFilter>("all"),
    [sort, setSort] = useState<{ key: InvoiceSort; desc: boolean }>({
      key: "number",
      desc: true,
    }),
    [shownInvoices, setShownInvoices] = useState(pageSize),
    [shownFreight, setShownFreight] = useState(pageSize),
    [open, setOpenState] = useState<
      { kind: "invoice" | "packet"; id: string } | "new" | null
    >(null),
    [linkNote, setLinkNote] = useState("");
  const setOpen = useCallback(
    (next: typeof open) => {
      setOpenState(next);
      onInvoiceChange?.(
        next && next !== "new" && next.kind === "invoice" ? next.id : null,
      );
    },
    [onInvoiceChange],
  );
  const retry = useRetryKey();
  // The invoice a link asked for. It is looked up (which carrier owns it),
  // that carrier is selected, its list is fetched with the invoice included,
  // and only then is the invoice opened or found missing. A list fetched
  // earlier, for another reason, says nothing about the link.
  const wanted = useRef<{
    id: string;
    carrier: string | null;
    ready: boolean;
  } | null>(null);
  // Only the newest request may fill the page: switching carriers quickly must
  // not let a slow earlier answer overwrite a later one.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!carrierId) return;
    const mine = ++loadSeq.current;
    const link = wanted.current;
    const withInvoice = !!link && link.carrier === carrierId;
    setBusy(true);
    setError("");
    try {
      const next = await api<BillingOverview>(
        "billing?carrier_id=" +
          carrierId +
          (withInvoice ? "&invoice_id=" + link.id : ""),
      );
      if (mine !== loadSeq.current) return;
      setData(next);
      if (withInvoice && wanted.current === link) link.ready = true;
    } catch (e) {
      if (mine !== loadSeq.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (mine === loadSeq.current) setBusy(false);
    }
  }, [api, carrierId, onAuthError]);
  useEffect(() => {
    // Fetch per selected carrier; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const ownCarriers = carriers.map((c) => c.id).join(",");
  useEffect(() => {
    if (!invoiceId || (open && open !== "new" && open.id === invoiceId)) return;
    let stale = false;
    const link = {
      id: invoiceId,
      carrier: null as string | null,
      ready: false,
    };
    wanted.current = link;
    api<{ carrier_id: string }>("dispatch-invoices/" + invoiceId)
      .then((r) => {
        if (stale) return;
        if (!ownCarriers.split(",").includes(r.carrier_id)) throw new Error();
        link.carrier = r.carrier_id;
        if (r.carrier_id === carrierId) void load();
        else setCarrierId(r.carrier_id);
      })
      .catch((e) => {
        if (stale) return;
        wanted.current = null;
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        // Not found and not yours read the same.
        setLinkNote("That invoice isn’t available to your account.");
        onInvoiceChange?.(null);
      });
    return () => {
      stale = true;
    };
    // Runs when the link changes, not when the list refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);
  useEffect(() => {
    const link = wanted.current;
    if (!link?.ready || !data || data.carrier_id !== link.carrier) return;
    wanted.current = null;
    if (data.invoices.some((i) => i.id === link.id)) {
      setLinkNote("");
      setOpenState({ kind: "invoice", id: link.id });
    } else {
      setLinkNote("That invoice isn’t available to your account.");
      onInvoiceChange?.(null);
    }
  }, [data, onInvoiceChange]);
  useEffect(() => {
    // Back or Forward closed the invoice the address named.
    if (!invoiceId && open && open !== "new" && open.kind === "invoice")
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenState(null);
  }, [invoiceId, open]);
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
  const balanceOf = (i: DispatchInvoice) =>
    i.status === "issued" ? BigInt(i.total_minor) - BigInt(i.paid_minor) : 0n;
  const sorted = (() => {
    const value = (i: DispatchInvoice): bigint | string =>
      sort.key === "number"
        ? // Newest first; drafts have no number yet and count as the newest.
          BigInt(/(\d+)\s*$/.exec(i.number ?? "")?.[1] ?? "999999999999")
        : sort.key === "due"
          ? i.due_on
          : sort.key === "total"
            ? BigInt(i.total_minor)
            : i.status === "issued"
              ? BigInt(i.total_minor) - BigInt(i.paid_minor)
              : 0n;
    return [...shown].sort((a, b) => {
      const x = value(a),
        y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -order : order;
    });
  })();
  const freightKind = (l: (typeof billable)[number]): FreightFilter =>
    l.packet?.payment_state === "paid"
      ? "paid"
      : l.packet?.status === "submitted"
        ? "submitted"
        : "needs-packet";
  const freightShown = billable.filter(
    (l) => freightFilter === "all" || freightKind(l) === freightFilter,
  );
  const sortBy = (key: InvoiceSort) => {
    setSort((old) => ({
      key,
      desc: old.key === key ? !old.desc : key !== "due",
    }));
    setShownInvoices(pageSize);
  };
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
          <p className="billingNote">
            Nothing here sends an invoice or moves money.
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
      <p
        className={notice || linkNote ? "inlineNotice" : "srOnly"}
        role="status"
      >
        {notice || linkNote || (busy ? "Loading billing" : "")}
      </p>
      {data && (
        <>
          <StatTiles label="Billing summary">
            <StatTile
              label="Outstanding"
              value={money(outstanding)}
              hint={`${openCount} open ${openCount === 1 ? "invoice" : "invoices"}`}
              actionLabel="Show open invoices"
              pressed={tab === "invoices" && filter === "open"}
              onSelect={() => {
                setTab("invoices");
                setFilter("open");
                setShownInvoices(pageSize);
              }}
            />
            <StatTile
              label="Overdue"
              value={money(overdue)}
              hint={`${overdueCount} past due`}
              tone={overdueCount ? "bad" : undefined}
              actionLabel="Show overdue invoices"
              pressed={tab === "invoices" && filter === "overdue"}
              onSelect={() => {
                setTab("invoices");
                setFilter("overdue");
                setShownInvoices(pageSize);
              }}
            />
            <StatTile
              label="Collected"
              value={money(collected)}
              hint="On issued invoices"
              tone="good"
              actionLabel="Show paid invoices"
              pressed={tab === "invoices" && filter === "paid"}
              onSelect={() => {
                setTab("invoices");
                setFilter("paid");
                setShownInvoices(pageSize);
              }}
            />
            <StatTile
              label="Ready to invoice"
              value={String(eligible.length)}
              hint={
                eligible.length === 1 ? "delivered load" : "delivered loads"
              }
              actionLabel={data.can_invoice ? "Start a new invoice" : undefined}
              onSelect={
                data.can_invoice && eligible.length
                  ? () => {
                      setTab("invoices");
                      setOpen("new");
                    }
                  : undefined
              }
            />
          </StatTiles>
          <Tabs
            label="Billing views"
            idPrefix="billing"
            items={[
              { id: "invoices", label: "Invoices", count: invoices.length },
              {
                id: "freight",
                label: "Carrier freight",
                count: billable.length,
              },
            ]}
            value={tab}
            onChange={setTab}
          />
          <TabPanel idPrefix="billing" value={tab}>
            {tab === "invoices" ? (
              <>
                <p className="helpText">
                  Relay&apos;s fee invoices to this carrier under the dispatch
                  agreement.
                </p>
                <ToggleGroup
                  label="Show invoices"
                  items={invoiceFilters.map(([key, label]) => ({
                    id: key,
                    label,
                    count: counts(key),
                    tone: key === "overdue" ? ("late" as const) : undefined,
                  }))}
                  hideEmpty
                  value={filter}
                  onChange={(key) => {
                    if (!key) return;
                    setFilter(key);
                    setShownInvoices(pageSize);
                  }}
                />
                {sorted.length > shownInvoices && (
                  <p className="helpText" role="status">
                    Showing {shownInvoices} of {sorted.length}
                  </p>
                )}
                {shown.length ? (
                  <div className="tableScroll billingTable">
                    <table className="reportTable">
                      <caption className="srOnly">Dispatch invoices</caption>
                      <thead>
                        <tr>
                          {(
                            [
                              ["number", "Invoice"],
                              [null, "Status"],
                              ["due", "Due"],
                              ["total", "Total"],
                              [null, "Paid"],
                              ["balance", "Balance"],
                            ] as [InvoiceSort | null, string][]
                          ).map(([key, label]) => (
                            <th
                              key={label}
                              scope="col"
                              aria-sort={
                                key && sort.key === key
                                  ? sort.desc
                                    ? "descending"
                                    : "ascending"
                                  : key
                                    ? "none"
                                    : undefined
                              }
                            >
                              {key ? (
                                <button
                                  type="button"
                                  className="sortButton"
                                  onClick={() => sortBy(key)}
                                >
                                  {label}
                                  {sort.key === key &&
                                    (sort.desc ? (
                                      <ArrowDownIcon
                                        size={11}
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <ArrowUpIcon
                                        size={11}
                                        aria-hidden="true"
                                      />
                                    ))}
                                </button>
                              ) : (
                                label
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.slice(0, shownInvoices).map((i) => {
                          const st = shownStatus(i, now);
                          const balance =
                            i.status === "issued"
                              ? BigInt(i.total_minor) - BigInt(i.paid_minor)
                              : 0n;
                          return (
                            <tr
                              key={i.id}
                              className="clickRow"
                              onClick={(e) => {
                                if (
                                  !(e.target as HTMLElement).closest("button")
                                )
                                  setOpen({ kind: "invoice", id: i.id });
                              }}
                            >
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
                              <td data-label="Due">
                                {i.due_on}
                                {aging(
                                  i.due_on,
                                  now,
                                  st.key !== "open" &&
                                    st.key !== "overdue" &&
                                    st.key !== "partial",
                                ) && (
                                  <small
                                    className={
                                      "agingNote" +
                                      (st.key === "overdue" ? " late" : "")
                                    }
                                  >
                                    {aging(i.due_on, now, false)}
                                  </small>
                                )}
                              </td>
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
                {sorted.length > shownInvoices && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShownInvoices((n) => n + pageSize)}
                  >
                    Show {Math.min(pageSize, sorted.length - shownInvoices)}{" "}
                    more
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="helpText">
                  The carrier&apos;s invoice to the broker or shipper. Proceeds
                  belong to the carrier; receipts are recorded as reported.
                </p>
                <ToggleGroup
                  label="Show freight bills"
                  items={freightFilters.map(([key, label]) => ({
                    id: key,
                    label,
                    count:
                      key === "all"
                        ? billable.length
                        : billable.filter((l) => freightKind(l) === key).length,
                  }))}
                  value={freightFilter}
                  onChange={(key) => {
                    if (!key) return;
                    setFreightFilter(key);
                    setShownFreight(pageSize);
                  }}
                />
                <label className="setupCheckbox">
                  <input
                    type="checkbox"
                    checked={allLoads}
                    onChange={(e) => setAllLoads(e.target.checked)}
                  />
                  <span>Show loads not yet delivered</span>
                </label>
                {freightShown.length ? (
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
                        {freightShown.slice(0, shownFreight).map((l) => {
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
                {freightShown.length > shownFreight && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShownFreight((n) => n + pageSize)}
                  >
                    Show{" "}
                    {Math.min(pageSize, freightShown.length - shownFreight)}{" "}
                    more
                  </button>
                )}
              </>
            )}
          </TabPanel>
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
