"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ErrorAlert } from "@/components/ui/feedback";
import { ApiError, useApi } from "@/lib/client-api";
import { formatMoney } from "@/lib/entry";
import { formatDate } from "@/lib/format";
import type { Claim, ClaimsOverview } from "@/lib/money-types";

const statusTone: Record<Claim["status"], [string, StatusTone]> = {
  draft: ["Draft", "neutral"],
  submitted: ["Sent to payer", "warn"],
  paid: ["Paid", "good"],
  denied: ["Denied", "bad"],
};
/** A sent claim this old with no answer is worth chasing. */
const CHASE_AFTER_DAYS = 14;
const wholeDays = (from: string) =>
  Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 86_400_000));

/**
 * Every detention and TONU claim for the carrier in one list (ADR 0071), with
 * what is still out and which sent claims have waited longest. The claim itself
 * is raised and settled on the load's Claims tab.
 */
export function ClaimsTab({
  carrierId,
  onAuthError,
}: {
  carrierId: string;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [data, setData] = useState<ClaimsOverview | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const d = await api<ClaimsOverview>(`claims?carrier_id=${carrierId}`);
      if (mine === seq.current) setData(d);
    } catch (e) {
      if (mine !== seq.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [api, carrierId, onAuthError]);
  useEffect(() => {
    // Fetch per carrier; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const overdue = (data?.claims ?? []).filter(
    (c) =>
      c.status === "submitted" &&
      c.submitted_at &&
      wholeDays(c.submitted_at) >= CHASE_AFTER_DAYS,
  );
  const columns: ColumnDefinition<Claim>[] = [
    {
      id: "load",
      header: "Load",
      accessor: "load_reference",
      rowHeader: true,
      render: (_, c) => (
        <Link href={`/loads/${c.load_id}`}>{c.load_reference}</Link>
      ),
    },
    {
      id: "kind",
      header: "Claim",
      accessor: (c) => (c.kind === "tonu" ? "TONU" : "Detention"),
    },
    {
      id: "status",
      header: "Status",
      accessor: (c) => statusTone[c.status][0],
      render: (_, c) => (
        <StatusBadge tone={statusTone[c.status][1]}>
          {statusTone[c.status][0]}
        </StatusBadge>
      ),
    },
    {
      id: "claimed",
      header: "Claimed",
      accessor: "claimed_minor",
      type: "money",
      render: (v) => formatMoney(v as string),
    },
    {
      id: "settled",
      header: "Paid",
      accessor: (c) => c.settled_minor,
      type: "money",
      render: (_, c) =>
        c.settled_minor === null ? "—" : formatMoney(c.settled_minor),
    },
    {
      id: "waiting",
      header: "Waiting",
      accessor: (c) => c.submitted_at,
      render: (_, c) => {
        if (c.status !== "submitted" || !c.submitted_at)
          return c.settled_at ? formatDate(c.settled_at) : "—";
        const n = wholeDays(c.submitted_at);
        return (
          <StatusBadge tone={n >= CHASE_AFTER_DAYS ? "bad" : "neutral"}>
            {n === 1 ? "1 day" : `${n} days`}
          </StatusBadge>
        );
      },
    },
    {
      id: "packet",
      header: "Packet",
      accessor: () => "",
      priority: "low",
      render: (_, c) => (
        <a
          href={`/api/claims/${c.id}/packet`}
          aria-label={`Download packet for ${c.load_reference}`}
        >
          Download
        </a>
      ),
    },
  ];
  const t = data?.totals;
  return (
    <div className="moneyStack">
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p className="srOnly" role="status" aria-live="polite">
        {loading ? "Loading claims" : ""}
      </p>
      {t && (
        <StatTiles label="Claims summary">
          <StatTile
            label="Drafts"
            value={formatMoney(t.draft_minor)}
            hint="Prepared, not yet sent to the payer"
          />
          <StatTile
            label="Sent, unanswered"
            value={formatMoney(t.submitted_minor)}
            hint={
              overdue.length
                ? `${overdue.length} waiting ${CHASE_AFTER_DAYS}+ days`
                : "Nothing waiting long"
            }
            tone={overdue.length ? "bad" : undefined}
          />
          <StatTile
            label="Paid"
            value={formatMoney(t.paid_minor)}
            hint="What payers paid, as you recorded it"
          />
        </StatTiles>
      )}
      <section className="moneyPanel" aria-labelledby="claims-all">
        <header>
          <h3 id="claims-all">Detention and TONU claims</h3>
        </header>
        {data?.list_truncated && (
          <p className="helpText">
            Showing the newest 200 claims. Older claims are on their loads.
          </p>
        )}
        <DataTable
          caption="Every detention and TONU claim for this carrier"
          columns={columns}
          data={data?.claims ?? []}
          getRowId={(c) => c.id}
          loading={loading && !data}
          empty={{
            title: "No claims yet",
            description:
              "Raise a detention or TONU claim from a load's Claims tab once its stop times and terms are recorded.",
          }}
        />
      </section>
    </div>
  );
}
