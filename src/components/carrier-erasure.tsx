"use client";
import { useState } from "react";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { ErrorAlert } from "@/components/ui/feedback";
import { useApi } from "@/lib/client-api";
import type { ChangeControl } from "@/lib/money-types";

const blockerText: Record<string, string> = {
  active_loads: "It still has loads that are not delivered or cancelled.",
  open_claims: "It has detention or TONU claims that are still open.",
  prepared_schedules:
    "It has a factoring schedule that is prepared but not handed over.",
};

type PlanRow = NonNullable<ChangeControl["erasure"]>["plan"][number];
const planColumns: ColumnDefinition<PlanRow>[] = [
  { id: "label", header: "Records", accessor: "label", rowHeader: true },
  {
    id: "action",
    header: "What happens",
    accessor: (p) => (p.action === "erase" ? "Removed" : "Kept"),
    render: (_, p) => (p.action === "erase" ? `Removed: ${p.removes}` : "Kept"),
  },
];

/**
 * Asking to erase a carrier (ADR 0074). Shown to organization administrators
 * only. Asking changes nothing: a different administrator has to approve, from
 * the same list as other approvals. Erased data cannot be brought back.
 */
export function CarrierErasure({
  carrierId,
  erasure,
  offline,
  onAsked,
  fail,
}: {
  carrierId: string;
  erasure: NonNullable<ChangeControl["erasure"]>;
  offline: boolean;
  onAsked: () => void | Promise<void>;
  fail: (e: unknown) => string;
}) {
  const api = useApi();
  const [form, setForm] = useState({
    confirm_name: "",
    reason: "",
    password: "",
    code: "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  if (erasure.erased)
    return <p className="helpText">This carrier was erased.</p>;
  const blocked = erasure.blockers.length > 0;
  return (
    <details>
      <summary>Erase this carrier&apos;s data</summary>
      <div className="changeItem">
        <p className="helpText">
          Erasing replaces the carrier&apos;s name and removes the personal and
          sensitive data below. Records Relay must keep for money and audit
          stay. It cannot be undone, and a different administrator has to
          approve it first.
        </p>
        <DataTable
          caption="What erasing does"
          columns={planColumns}
          data={erasure.plan}
          getRowId={(p) => p.id}
          empty={{ title: "Nothing to show", description: "" }}
        />
        {blocked && (
          <ErrorAlert polite>
            It cannot be erased yet.{" "}
            {erasure.blockers.map((b) => blockerText[b] ?? b).join(" ")}
          </ErrorAlert>
        )}
        {error && <ErrorAlert error={error} />}
        <p
          className={notice ? "inlineNotice" : "srOnly"}
          role="status"
          aria-live="polite"
        >
          {notice}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            api("change-control/carrier-erasure", {
              carrier_id: carrierId,
              confirm_name: form.confirm_name,
              reason: form.reason,
              password: form.password,
              ...(form.code.trim() ? { code: form.code.trim() } : {}),
              key: crypto.randomUUID(),
            })
              .then(async () => {
                setNotice(
                  "Asked. Nothing is erased until a different administrator approves.",
                );
                setForm({
                  confirm_name: "",
                  reason: "",
                  password: "",
                  code: "",
                });
                await onAsked();
              })
              .catch((err) => setError(fail(err)))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            <span>Type the carrier&apos;s name to confirm</span>
            <input
              required
              maxLength={160}
              value={form.confirm_name}
              onChange={(e) =>
                setForm({ ...form, confirm_name: e.target.value })
              }
            />
          </label>
          <label>
            <span>Why it is being erased</span>
            <input
              required
              maxLength={500}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </label>
          <label>
            <span>Your password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <label>
            <span>Authenticator or recovery code</span>
            <input
              autoComplete="one-time-code"
              maxLength={40}
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
            <small>Only if you use two-step verification.</small>
          </label>
          <div className="formActions">
            <button
              type="submit"
              className="primary"
              disabled={offline || busy || blocked}
            >
              Ask for approval to erase
            </button>
          </div>
        </form>
        {erasure.pending_files > 0 && (
          <p className="helpText">
            {erasure.pending_files} stored{" "}
            {erasure.pending_files === 1 ? "file is" : "files are"} still being
            deleted from storage.
          </p>
        )}
      </div>
    </details>
  );
}
