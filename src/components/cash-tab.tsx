"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ErrorAlert } from "@/components/ui/feedback";
import { ApiError, useApi } from "@/lib/client-api";
import { cashStageLabels, type CashStage } from "@/lib/cash";
import { formatMoney, formatBps, percentToBps } from "@/lib/entry";
import { formatDate } from "@/lib/format";
import { ownerLabels } from "@/lib/readiness-rules";
import type {
  CashLoad,
  CashOverview,
  Readiness,
  ReadinessLoad,
} from "@/lib/money-types";

const stageTone: Record<CashStage, StatusTone> = {
  not_delivered: "neutral",
  waiting_on_pod: "warn",
  ready_for_packet: "warn",
  awaiting_payment: "neutral",
  partly_paid: "neutral",
  factored: "neutral",
  paid: "good",
};
const days = (n: number | null) =>
  n === null ? "—" : n === 1 ? "1 day" : `${n} days`;

/**
 * What each delivered load earned after the dispatch fee, how long its money
 * is taking, and which loads are held up by paperwork and by whom (ADRs 0066
 * and 0068). A fee is the real invoiced one, or an estimate only after the
 * person previews a percentage; otherwise it is "not invoiced" and there is no
 * net figure.
 */
export function CashTab({
  carrierId,
  offline,
  onAuthError,
}: {
  carrierId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [preview, setPreview] = useState(""),
    [bps, setBps] = useState<number | null>(null),
    [previewError, setPreviewError] = useState(""),
    [cash, setCash] = useState<CashOverview | null>(null),
    [paper, setPaper] = useState<Readiness | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const [c, p] = await Promise.all([
        api<CashOverview>(
          `billing/cash?carrier_id=${carrierId}${bps ? "&fee_bps=" + bps : ""}`,
        ),
        api<Readiness>(`documents/readiness?carrier_id=${carrierId}`),
      ]);
      if (mine !== seq.current) return;
      setCash(c);
      setPaper(p);
    } catch (e) {
      if (mine !== seq.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [api, carrierId, bps, onAuthError]);
  useEffect(() => {
    // Fetch per carrier and preview; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function applyPreview(e: React.FormEvent) {
    e.preventDefault();
    setPreviewError("");
    if (!preview.trim()) return setBps(null);
    try {
      setBps(percentToBps(preview));
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "Enter a percentage.",
      );
    }
  }

  const columns: ColumnDefinition<CashLoad>[] = [
    { id: "ref", header: "Load", accessor: "reference", rowHeader: true },
    {
      id: "stage",
      header: "Where the money is",
      accessor: (l) => cashStageLabels[l.cash_stage],
      render: (_, l) => (
        <StatusBadge tone={stageTone[l.cash_stage]}>
          {cashStageLabels[l.cash_stage]}
        </StatusBadge>
      ),
    },
    {
      id: "waiting",
      header: "Waiting on",
      accessor: (l) =>
        l.waiting_on === "payer"
          ? (l.payer ?? "The payer")
          : l.waiting_on === "factor"
            ? "The factor"
            : l.waiting_on
              ? ownerLabels[l.waiting_on]
              : "—",
    },
    {
      id: "gross",
      header: "Rate",
      accessor: "gross_minor",
      type: "money",
      render: (v) => formatMoney(v as string),
    },
    {
      id: "fee",
      header: "Dispatch fee",
      accessor: (l) => l.fee.minor,
      type: "money",
      render: (_, l) =>
        l.fee.minor === null ? (
          <span className="helpText">Not invoiced</span>
        ) : (
          <>
            {formatMoney(l.fee.minor)}{" "}
            <span className="helpText">
              {l.fee.state === "estimate"
                ? "estimate at "
                : l.fee.state === "draft"
                  ? "draft invoice, "
                  : ""}
              {l.fee.bps !== null ? formatBps(l.fee.bps) : ""}
            </span>
          </>
        ),
    },
    {
      id: "net",
      header: "After our fee",
      accessor: (l) => l.net_minor,
      type: "money",
      render: (_, l) => (l.net_minor === null ? "—" : formatMoney(l.net_minor)),
    },
    {
      id: "days",
      header: "Days",
      accessor: (l) => l.days.to_cash ?? l.days.waiting,
      type: "number",
      render: (_, l) =>
        l.days.to_cash !== null
          ? `${days(l.days.to_cash)} to cash`
          : l.days.waiting !== null
            ? `${days(l.days.waiting)} waiting`
            : "—",
    },
  ];
  const paperColumns: ColumnDefinition<ReadinessLoad>[] = [
    { id: "ref", header: "Load", accessor: "reference", rowHeader: true },
    {
      id: "items",
      header: "What is missing",
      accessor: (l) => l.items.map((i) => i.label).join(", "),
      render: (_, l) => (
        <ul className="flagList">
          {l.items.map((i) => (
            <li key={i.type}>
              {i.action}{" "}
              <StatusBadge tone={i.owed_by === "driver" ? "warn" : "neutral"}>
                {ownerLabels[i.owed_by]}
              </StatusBadge>
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: "billing",
      header: "Billing",
      accessor: (l) => (l.blocks_billing ? "Held up" : "Not due yet"),
      render: (_, l) => (
        <StatusBadge tone={l.blocks_billing ? "bad" : "neutral"}>
          {l.blocks_billing ? "Held up" : "Not due yet"}
        </StatusBadge>
      ),
    },
    {
      id: "since",
      header: "Delivered",
      accessor: (l) => l.delivered_on,
      priority: "low",
      render: (_, l) =>
        l.delivered_on
          ? `${formatDate(l.delivered_on)} (${days(l.days_outstanding)})`
          : "Not yet",
    },
  ];

  const s = cash?.summary;
  return (
    <div className="moneyStack">
      <form className="moneyBar" onSubmit={applyPreview}>
        <label>
          <span>Preview a dispatch fee (%)</span>
          <input
            inputMode="decimal"
            value={preview}
            placeholder="8.5"
            aria-describedby="cash-preview-help"
            onChange={(e) => setPreview(e.target.value)}
          />
        </label>
        <button type="submit" className="secondary" disabled={offline}>
          Show estimate
        </button>
        <p id="cash-preview-help" className="helpText">
          Loads on a dispatch invoice always show their real fee. A preview only
          fills in the others and is labelled an estimate. Days are counted in
          whole UTC days.
        </p>
      </form>
      {previewError && <ErrorAlert polite>{previewError}</ErrorAlert>}
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p className="srOnly" role="status" aria-live="polite">
        {loading ? "Loading cash figures" : ""}
      </p>
      {s && (
        <StatTiles label="Cash summary">
          <StatTile
            label="After our fee"
            value={formatMoney(s.net_minor)}
            hint={
              (s.net_loads === s.loads
                ? `On ${s.loads} delivered loads. `
                : `Only the ${s.net_loads} of ${s.loads} loads with a known fee. `) +
              (s.net_draft_loads
                ? `${s.net_draft_loads} on a draft invoice. `
                : "") +
              "Factoring and quick-pay fees are not taken off."
            }
          />
          <StatTile
            label="Billed, not yet paid"
            value={formatMoney(s.outstanding_minor)}
            hint={`${s.unpaid - s.with_factor_loads - s.unbilled_loads} billed ${s.unpaid - s.with_factor_loads - s.unbilled_loads === 1 ? "load" : "loads"}, not counting the factor's`}
          />
          <StatTile
            label="With the factor"
            value={formatMoney(s.with_factor_minor)}
            hint={`${s.with_factor_loads} ${s.with_factor_loads === 1 ? "load" : "loads"} handed over; record what the factor pays you`}
          />
          <StatTile
            label="Not billed yet"
            value={formatMoney(s.unbilled_gross_minor)}
            hint={`${s.unbilled_loads} delivered ${s.unbilled_loads === 1 ? "load" : "loads"} with no billing packet (rate shown)`}
            tone={s.unbilled_loads ? "bad" : undefined}
          />
          <StatTile
            label="Average days to cash"
            value={
              s.avg_days_to_cash === null ? "—" : String(s.avg_days_to_cash)
            }
            hint={
              s.paid
                ? `From delivery to the payment you recorded, on ${s.paid} paid`
                : "No paid loads yet"
            }
          />
          <StatTile
            label="Longest wait"
            value={
              s.oldest_waiting_days === null ? "—" : days(s.oldest_waiting_days)
            }
            hint="Oldest unpaid load"
            tone={(s.oldest_waiting_days ?? 0) >= 30 ? "bad" : undefined}
          />
        </StatTiles>
      )}
      <section className="moneyPanel" aria-labelledby="cash-loads">
        <header>
          <h3 id="cash-loads">Delivered loads</h3>
        </header>
        {cash?.list_truncated && (
          <p className="helpText">
            Showing the newest {cash.loads.length} of {cash.summary.loads}{" "}
            delivered loads. The figures above count all of them.
          </p>
        )}
        {cash?.totals_partial && (
          <ErrorAlert polite>
            This carrier has more delivered loads than can be added up here, so
            the figures cover only the newest {cash.summary.loads}.
          </ErrorAlert>
        )}
        <DataTable
          caption="Delivered loads: what each earned and where its money is"
          columns={columns}
          data={cash?.loads ?? []}
          getRowId={(l) => l.id}
          loading={loading && !cash}
          empty={{
            title: "No delivered loads yet",
            description:
              "When loads are delivered, this shows what each earned after the dispatch fee and how long the money takes.",
          }}
        />
      </section>
      <section className="moneyPanel" aria-labelledby="cash-paper">
        <header>
          <h3 id="cash-paper">Paperwork holding up billing</h3>
        </header>
        {paper?.list_truncated && (
          <p className="helpText">
            Showing {paper.loads.length} of {paper.summary.loads} loads with
            paperwork to do, the most urgent first.
          </p>
        )}
        {paper?.scan_truncated && (
          <ErrorAlert polite>
            Only the newest {paper.loads_scanned} loads were checked. Older
            loads may also be waiting on paperwork.
          </ErrorAlert>
        )}
        <DataTable
          caption="Loads with paperwork still to do, and who has to act"
          columns={paperColumns}
          data={paper?.loads ?? []}
          getRowId={(l) => l.id}
          loading={loading && !paper}
          empty={{
            title: "Nothing is waiting on paperwork",
            description:
              "Every open load has its rate confirmation, bill of lading and proof of delivery accepted.",
          }}
        />
      </section>
    </div>
  );
}
