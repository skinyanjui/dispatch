"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReceiptIcon, FileTextIcon } from "@phosphor-icons/react";
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
        <h4>{row.reference}</h4>
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
      <p className="opsMeta">
        Agreed rate {formatMoney(row.amount_minor)}
        {packet && (
          <>
            {" "}
            · Carrier invoice {packet.carrier_invoice_number} to{" "}
            {packet.bill_to} for {formatMoney(packet.amount_minor)} · Received{" "}
            {formatMoney(packet.paid_minor)}
          </>
        )}
      </p>
      {packet?.receipts.map((r) => (
        <p className="opsMeta" key={r.id}>
          Receipt {formatMoney(r.amount_minor)} on {r.received_on}
          {r.reference && <> · {r.reference}</>}
        </p>
      ))}
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
        <h4>{label}</h4>
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
      <p className="opsMeta">
        Dispatch fee {formatBps(invoice.fee_bps)} · Total{" "}
        {formatMoney(invoice.total_minor)} · Paid{" "}
        {formatMoney(invoice.paid_minor)} · Due {invoice.due_on}
        {invoice.void_reason && <> · Voided: {invoice.void_reason}</>}
      </p>
      <ul className="opsLines">
        {invoice.lines.map((l) => (
          <li key={l.load_id}>
            {l.reference}: {formatMoney(l.fee_minor)} on{" "}
            {formatMoney(l.load_amount_minor)}
          </li>
        ))}
      </ul>
      {invoice.payments.map((p) => (
        <p className="opsMeta" key={p.id}>
          Payment {formatMoney(p.amount_minor)} by {p.method.toUpperCase()} on{" "}
          {p.received_on}
          {p.reference && <> · {p.reference}</>}
        </p>
      ))}
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

export function BillingWorkspace({
  context,
  offline,
  onAuthError,
}: {
  context: Context;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const carriers = context.carriers.filter((c) => c.role !== "driver");
  const [carrierId, setCarrierId] = useState(carriers[0]?.id || ""),
    [data, setData] = useState<BillingOverview | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [fee, setFee] = useState("8");
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
  return (
    <section className="carrierDirectory" aria-label="Billing and payments">
      <div className="directoryIntro">
        <div>
          <p className="eyebrow">FINANCE</p>
          <h2>Billing and payments</h2>
          <p>
            Carrier freight billing and Relay&apos;s dispatch-service invoices
            are tracked separately. Nothing here sends an invoice or moves
            money.
          </p>
        </div>
        <div className="directoryControls opsFilters">
          <label>
            <span className="srOnly">Carrier</span>
            <select
              value={carrierId}
              onChange={(e) => {
                setCarrierId(e.target.value);
                setSelected([]);
                setNotice("");
              }}
            >
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
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
        <div className="billingColumns">
          <div>
            <h3>Carrier freight billing</h3>
            <p className="helpText">
              The carrier&apos;s invoice to the broker or shipper. Proceeds
              belong to the carrier; receipts are recorded as reported.
            </p>
            <div className="opsList">
              {data.loads.length ? (
                data.loads.map((row) => (
                  <PacketCard
                    key={row.id}
                    row={row}
                    disabled={disabled}
                    run={run}
                  />
                ))
              ) : (
                <p className="helpText">No loads for this carrier yet.</p>
              )}
            </div>
          </div>
          <div>
            <h3>Relay dispatch-service invoices</h3>
            <p className="helpText">
              Relay&apos;s fee invoices to the carrier under the dispatch
              agreement.
            </p>
            {data.can_invoice && (
              <form
                className="opsForm opsCard"
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
                    return "Draft dispatch invoice created. Review it, then issue.";
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
                      defaultValue={today()}
                    />
                  </label>
                </div>
                {preview && selected.length > 0 && (
                  <small>
                    Invoice total: {preview} (rounded half up per load)
                  </small>
                )}
                <button
                  className="primary"
                  disabled={disabled || !selected.length}
                >
                  Create draft invoice
                </button>
              </form>
            )}
            <div className="opsList">
              {data.invoices.length ? (
                data.invoices.map((invoice) => (
                  <InvoiceCard
                    key={invoice.id}
                    invoice={invoice}
                    canInvoice={data.can_invoice}
                    disabled={disabled}
                    run={run}
                  />
                ))
              ) : (
                <p className="helpText">No dispatch invoices yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
