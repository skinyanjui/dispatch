"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ErrorAlert } from "@/components/ui/feedback";
import { Sheet } from "@/components/modal";
import { ApiError, useApi } from "@/lib/client-api";
import { formatMoney } from "@/lib/entry";
import { formatDateTime } from "@/lib/format";
import type { FactoringOverview } from "@/lib/money-types";

type Batch = FactoringOverview["batches"][number];
type Candidate = FactoringOverview["loads"][number];
const batchLabels: Record<Batch["status"], [string, StatusTone]> = {
  prepared: ["Prepared", "warn"],
  handed_off: ["Handed to the factor", "good"],
  void: ["Cancelled", "neutral"],
};

/**
 * Factoring handoff (ADR 0069). Relay prepares a schedule of invoices for the
 * carrier's factor and records that the carrier handed it over; it sends
 * nothing. Only the carrier's manager can agree to share billing data.
 */
export function FactoringTab({
  carrierId,
  offline,
  onAuthError,
}: {
  carrierId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [data, setData] = useState<FactoringOverview | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [factor, setFactor] = useState(""),
    [consent, setConsent] = useState(false),
    [picked, setPicked] = useState<string[]>([]),
    [voiding, setVoiding] = useState<Batch | null>(null),
    [reason, setReason] = useState(""),
    [informed, setInformed] = useState(false),
    [releasing, setReleasing] = useState<Batch | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  // One identity per unchanged selection, so a retry after a lost reply is safe.
  const retry = useRef<{ sig: string; key: string } | null>(null);
  const keyFor = (sig: string) => {
    if (retry.current?.sig !== sig)
      retry.current = { sig, key: crypto.randomUUID() };
    return retry.current.key;
  };
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api<FactoringOverview>(
        "factoring?carrier_id=" + carrierId,
      );
      setData(next);
      setFactor((f) => f || next.settings.factor_name);
      setPicked((p) =>
        p.filter((id) => next.loads.some((l) => l.id === id && l.eligible)),
      );
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [api, carrierId, fail]);
  useEffect(() => {
    // Fetch per carrier; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(done);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const save = (enabled: boolean) =>
    run(
      () =>
        api("factoring/settings", {
          carrier_id: carrierId,
          enabled,
          factor_name: factor.trim(),
          consent: enabled && consent,
        }),
      enabled
        ? "Sharing is on. Schedules can now be prepared for this factor."
        : "Sharing is off. Nothing more is offered for the factor.",
    );
  const prepare = () =>
    run(
      () =>
        api("factoring/batches", {
          carrier_id: carrierId,
          load_ids: picked,
          key: keyFor([...picked].sort().join(",")),
        }),
      "Schedule prepared. Download it and give it to your factor; then mark it handed over.",
    ).then(() => setPicked([]));

  const eligible = (data?.loads ?? []).filter((l) => l.eligible);
  const total = eligible
    .filter((l) => picked.includes(l.id))
    .reduce((t, l) => t + BigInt(l.amount_minor ?? "0"), 0n);
  const loadColumns: ColumnDefinition<Candidate>[] = [
    {
      id: "pick",
      header: "Include",
      accessor: "id",
      render: (_, l) =>
        l.eligible ? (
          <input
            type="checkbox"
            aria-label={`Include ${l.reference}`}
            checked={picked.includes(l.id)}
            disabled={offline || !data?.payout_in_force}
            onChange={(e) =>
              setPicked((p) =>
                e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id),
              )
            }
          />
        ) : null,
    },
    { id: "ref", header: "Load", accessor: "reference", rowHeader: true },
    { id: "invoice", header: "Your invoice", accessor: "invoice_number" },
    { id: "payer", header: "Bill to", accessor: "bill_to", priority: "low" },
    {
      id: "amount",
      header: "Amount",
      accessor: "amount_minor",
      type: "money",
      render: (v) => (v ? formatMoney(v as string) : "—"),
    },
    {
      id: "state",
      header: "Status",
      accessor: (l) => l.reason_label ?? "Ready",
      render: (_, l) => (
        <StatusBadge tone={l.eligible ? "good" : "neutral"}>
          {l.reason_label ?? "Ready"}
        </StatusBadge>
      ),
    },
  ];
  const batchColumns: ColumnDefinition<Batch>[] = [
    {
      id: "when",
      header: "Prepared",
      accessor: "created_at",
      type: "datetime",
      render: (v) => formatDateTime(v as string),
    },
    { id: "factor", header: "Factor", accessor: "factor_name" },
    { id: "n", header: "Loads", accessor: "load_count", type: "number" },
    {
      id: "total",
      header: "Total",
      accessor: "total_minor",
      type: "money",
      render: (v) => formatMoney(v as string),
    },
    {
      id: "status",
      header: "Status",
      accessor: (b) => batchLabels[b.status][0],
      render: (_, b) => (
        <StatusBadge tone={batchLabels[b.status][1]}>
          {batchLabels[b.status][0]}
        </StatusBadge>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      accessor: "id",
      align: "right",
      render: (_, b) => (
        <div className="rowActions">
          <a
            className="secondary"
            href={`/api/factoring/batches/${b.id}/file`}
            download
          >
            Download
            <span className="srOnly"> schedule of {b.load_count} loads</span>
          </a>
          {b.status === "prepared" && (
            <button
              type="button"
              className="secondary"
              disabled={offline || busy}
              onClick={() =>
                void run(
                  () =>
                    api(`factoring/batches/${b.id}/handoff`, {
                      version: b.version,
                    }),
                  "Recorded as handed to the factor.",
                )
              }
            >
              Mark handed over
            </button>
          )}
          {b.status !== "void" && (
            <button
              type="button"
              className="secondary"
              disabled={offline || busy}
              onClick={() => {
                setReason("");
                setInformed(false);
                setVoiding(b);
              }}
            >
              Cancel<span className="srOnly"> this schedule</span>
            </button>
          )}
          {b.loads_held && (
            <button
              type="button"
              className="secondary"
              disabled={offline || busy}
              onClick={() => {
                setConfirmed(false);
                setReleasing(b);
              }}
            >
              Release loads<span className="srOnly"> of this schedule</span>
            </button>
          )}
        </div>
      ),
    },
  ];

  const s = data?.settings;
  return (
    <div className="moneyStack">
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p
        className={notice ? "inlineNotice" : "srOnly"}
        role="status"
        aria-live="polite"
      >
        {notice || (loading ? "Loading factoring" : "")}
      </p>
      {data && (
        <>
          <section className="moneyPanel" aria-labelledby="fac-consent">
            <header>
              <h3 id="fac-consent">Sharing with a factor</h3>
              <StatusBadge tone={s?.enabled ? "good" : "neutral"}>
                {s?.enabled ? "On" : "Off"}
              </StatusBadge>
            </header>
            <div className="moneyBody">
              <p className="helpText">
                Relay prepares a schedule of this carrier&apos;s invoices for
                its factor. Relay does not send it: you download it and hand it
                over, then record that you did.
              </p>
              {s?.enabled && s.consented_at && (
                <p>
                  {s.consented_by} agreed on {formatDateTime(s.consented_at)} to
                  share this carrier&apos;s billing data with{" "}
                  <strong>{s.factor_name}</strong>.
                </p>
              )}
              {data.can_consent ? (
                <form
                  className="moneyBar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(true);
                  }}
                >
                  <label>
                    <span>Factor&apos;s name</span>
                    <input
                      value={factor}
                      maxLength={160}
                      onChange={(e) => setFactor(e.target.value)}
                    />
                  </label>
                  <label className="filterCheck">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I agree to share this carrier&apos;s billing data with
                      this factor
                    </span>
                  </label>
                  <button
                    type="submit"
                    className="primary"
                    disabled={offline || busy || !factor.trim() || !consent}
                  >
                    {s?.enabled ? "Save" : "Turn on"}
                  </button>
                  {s?.enabled && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={offline || busy}
                      onClick={() => void save(false)}
                    >
                      Turn off
                    </button>
                  )}
                </form>
              ) : (
                !s?.enabled && (
                  <p className="helpText">
                    Only the carrier&apos;s manager can agree to this. Ask them
                    to turn it on here.
                  </p>
                )
              )}
              {s?.enabled && !data.payout_in_force && (
                <ErrorAlert polite>
                  {data.payout_cooling_off
                    ? "This carrier's new payout details are still cooling off, so schedules can't be prepared yet."
                    : "This carrier has no payout details on file. Add them (and have a second person approve) before preparing a schedule."}
                </ErrorAlert>
              )}
            </div>
          </section>
          {s?.enabled && (
            <>
              <section className="moneyPanel" aria-labelledby="fac-loads">
                <header>
                  <h3 id="fac-loads">Invoices ready for the factor</h3>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      offline || busy || !picked.length || !data.payout_in_force
                    }
                    onClick={() => void prepare()}
                  >
                    Prepare schedule
                    {picked.length
                      ? ` (${picked.length}, ${formatMoney(total.toString())})`
                      : ""}
                  </button>
                </header>
                <DataTable
                  caption="Loads and whether they can go in a factoring schedule"
                  columns={loadColumns}
                  data={data.loads}
                  getRowId={(l) => l.id}
                  empty={{
                    title: "No loads yet",
                    description:
                      "Loads appear here once they are delivered, documented and billed.",
                  }}
                />
              </section>
              <section className="moneyPanel" aria-labelledby="fac-batches">
                <header>
                  <h3 id="fac-batches">Schedules</h3>
                </header>
                <DataTable
                  caption="Factoring schedules"
                  columns={batchColumns}
                  data={data.batches}
                  getRowId={(b) => b.id}
                  empty={{
                    title: "No schedules yet",
                    description: "Choose loads above and prepare one.",
                  }}
                />
              </section>
            </>
          )}
        </>
      )}
      {releasing && (
        <Sheet
          label="Release loads"
          eyebrow="Factoring"
          onClose={() => setReleasing(null)}
        >
          <form
            className="inspectorBody"
            onSubmit={(e) => {
              e.preventDefault();
              const b = releasing;
              setReleasing(null);
              void run(
                () =>
                  api(`factoring/batches/${b.id}/release`, {
                    version: b.version,
                    factor_confirmed_no_advance: true,
                  }),
                "Loads released. They can go in a new schedule.",
              );
            }}
          >
            <h2>Release these loads?</h2>
            <p className="setupIntro">
              Only release them once the factor has confirmed it has not
              advanced money against these {releasing.load_count} invoices.
              Otherwise the same invoices could be financed twice.
            </p>
            <label className="filterCheck">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>The factor confirmed it has not advanced on them</span>
            </label>
            <div className="formActions">
              <button type="submit" className="primary" disabled={!confirmed}>
                Release loads
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setReleasing(null)}
              >
                Keep them held
              </button>
            </div>
          </form>
        </Sheet>
      )}
      {voiding && (
        <Sheet
          label="Cancel schedule"
          eyebrow="Factoring"
          onClose={() => setVoiding(null)}
        >
          <form
            className="inspectorBody"
            onSubmit={(e) => {
              e.preventDefault();
              const b = voiding;
              setVoiding(null);
              void run(
                () =>
                  api(`factoring/batches/${b.id}/void`, {
                    version: b.version,
                    reason: reason.trim(),
                    factor_informed: informed,
                  }),
                b.status === "handed_off"
                  ? "Schedule cancelled. Its loads stay held until the factor confirms it has not advanced on them."
                  : "Schedule cancelled. Its loads can go in a new one.",
              );
            }}
          >
            <h2>Cancel this schedule?</h2>
            <p className="setupIntro">
              {voiding.status === "handed_off"
                ? `You already gave this schedule to the factor, who may have advanced money against its ${voiding.load_count} loads. They stay held, and cannot go in a new schedule, until the factor confirms it has not advanced on them.`
                : `Its ${voiding.load_count} loads are released so they can go in a new schedule.`}
            </p>
            {voiding.status === "handed_off" && (
              <label className="filterCheck">
                <input
                  type="checkbox"
                  checked={informed}
                  onChange={(e) => setInformed(e.target.checked)}
                />
                <span>I have told the factor this schedule is cancelled</span>
              </label>
            )}
            <label>
              <span>Why</span>
              <input
                autoFocus
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="formActions">
              <button
                type="submit"
                className="primary"
                disabled={!reason.trim()}
              >
                Cancel schedule
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setVoiding(null)}
              >
                Keep it
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </div>
  );
}
