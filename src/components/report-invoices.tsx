"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, useApi } from "@/lib/client-api";
import type { WorkspaceFilters } from "@/lib/routes";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { ErrorAlert } from "@/components/ui/feedback";

type Invoice = {
  id: string;
  number: string;
  carrier_name: string;
  total_minor: string;
  paid_minor: string;
  outstanding_minor: string;
  due_on: string;
};
export function ReportInvoices({
  scope,
  onOpen,
  onAuthError,
}: {
  scope: WorkspaceFilters;
  onOpen: (id: string) => void;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi(),
    request = useRef(0);
  const [rows, setRows] = useState<Invoice[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const query = new URLSearchParams(scope).toString();
  const load = useCallback(
    async (after?: string) => {
      const id = ++request.current;
      setBusy(true);
      setError("");
      try {
        const result = await api<{
          invoices: Invoice[];
          nextCursor: string | null;
        }>("reports/invoices?" + query + (after ? "&cursor=" + after : ""));
        if (id !== request.current) return;
        setRows((old) =>
          after
            ? [
                ...old,
                ...result.invoices.filter(
                  (x) => !old.some((y) => y.id === x.id),
                ),
              ]
            : result.invoices,
        );
        setCursor(result.nextCursor);
      } catch (e) {
        if (id !== request.current) return;
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [api, query, onAuthError],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const columns: ColumnDefinition<Invoice>[] = [
    { id: "number", header: "Invoice", accessor: "number" },
    { id: "carrier", header: "Carrier", accessor: "carrier_name" },
    { id: "total", header: "Issued", accessor: "total_minor", type: "money" },
    {
      id: "paid",
      header: "Paid to date",
      accessor: "paid_minor",
      type: "money",
    },
    {
      id: "balance",
      header: "Outstanding",
      accessor: "outstanding_minor",
      type: "money",
    },
    { id: "due", header: "Due", accessor: "due_on", type: "date" },
  ];
  return (
    <section aria-label="Invoice report records">
      <p className="helpText">
        Invoices issued {scope.from} through {scope.to} UTC
        {scope.balance === "outstanding"
          ? " with a current unpaid balance"
          : ""}
        . Payments and balances are current recorded amounts.
      </p>
      <ErrorAlert error={error} onRetry={() => void load()} />
      <DataTable
        caption="Matching invoices"
        columns={columns}
        data={rows}
        getRowId={(x) => x.id}
        loading={busy && !rows.length}
        onRowOpen={(x) => onOpen(x.id)}
        empty={{ title: "No matching invoices" }}
      />
      {cursor && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          Load more matching invoices
        </button>
      )}
      <p className="helpText">
        {rows.length} matching invoices loaded{cursor ? "; more available" : ""}
        .
      </p>
    </section>
  );
}
