"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ErrorAlert } from "@/components/ui/feedback";
import { ApiError, useApi } from "@/lib/client-api";
import { dollarsToMinor, formatMoney } from "@/lib/entry";
import { formatDateTime } from "@/lib/format";
import type { Claim, ClaimTerms, LoadClaims } from "@/lib/money-types";

const statusLabels: Record<Claim["status"], [string, StatusTone]> = {
  draft: ["Draft", "warn"],
  submitted: ["Sent", "neutral"],
  paid: ["Paid", "good"],
  denied: ["Denied", "bad"],
};
const issueLabels: Record<string, string> = {
  no_terms: "No terms set",
  not_arrived: "No arrival recorded",
  not_departed: "No departure recorded",
  arrived_after_window: "Arrived after the appointment window",
  times_were_corrected: "A recorded time was corrected",
  recorded_late: "A time was recorded more than a day after it happened",
};
const sourceLabels: Record<ClaimTerms["source"], string> = {
  rate_confirmation: "The rate confirmation",
  agreement: "A written agreement",
  verbal: "A verbal agreement",
};
const minorToDollars = (minor: string | null) =>
  minor === null
    ? ""
    : `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, "0")}`;

/**
 * Detention and TONU for one load (ADR 0067): the terms the load was booked
 * on, what each stop's recorded times add up to, and claims that freeze their
 * evidence and move from draft to sent to paid or denied. Relay prepares the
 * packet; the carrier is the claimant.
 */
export function LoadClaimsTab({
  loadId,
  offline,
  onAuthError,
}: {
  loadId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [data, setData] = useState<LoadClaims | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState({
      free: "120",
      rate: "",
      cap: "",
      tonu: "",
      source: "rate_confirmation" as ClaimTerms["source"],
    }),
    [settle, setSettle] = useState<{ id: string; amount: string } | null>(null);
  const loaded = useRef(false);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    try {
      const next = await api<LoadClaims>("claims/load?load_id=" + loadId);
      setData(next);
      if (next.terms && !loaded.current)
        setForm({
          free: String(next.terms.free_minutes),
          rate: minorToDollars(next.terms.rate_minor_per_hour),
          cap:
            next.terms.cap_minutes === null
              ? ""
              : String(next.terms.cap_minutes),
          tonu: minorToDollars(next.terms.tonu_minor),
          source: next.terms.source,
        });
      loaded.current = true;
      setError("");
    } catch (e) {
      fail(e);
    }
  }, [api, loadId, fail]);
  useEffect(() => {
    // Fetch per load; state is set after the response.
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
  function saveTerms(e: React.FormEvent) {
    e.preventDefault();
    let body;
    try {
      body = {
        load_id: loadId,
        free_minutes: Number(form.free),
        rate_minor_per_hour: form.rate ? dollarsToMinor(form.rate) : 0,
        cap_minutes: form.cap ? Number(form.cap) : null,
        tonu_minor: form.tonu ? dollarsToMinor(form.tonu) : null,
        source: form.source,
        version: data?.terms?.version ?? 0,
      };
    } catch (err) {
      return setError(err instanceof Error ? err.message : "VALIDATION_ERROR");
    }
    void run(() => api("claims/terms", body), "Terms saved.");
  }
  const start = (kind: "detention" | "tonu", stopId?: string) =>
    run(
      () =>
        api("claims", {
          load_id: loadId,
          kind,
          ...(stopId ? { stop_id: stopId } : {}),
          note: "",
          key: crypto.randomUUID(),
        }),
      "Draft claim started from the times recorded now.",
    );
  const open = (stopId: string | null, kind: string) =>
    data?.claims.some(
      (c) =>
        c.kind === kind &&
        c.stop_id === stopId &&
        (c.status === "draft" || c.status === "submitted"),
    );
  const hasOpen = !!data?.claims.some(
    (c) => c.status === "draft" || c.status === "submitted",
  );
  return (
    <div className="moneyStack">
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p
        className={notice ? "inlineNotice" : "srOnly"}
        role="status"
        aria-live="polite"
      >
        {notice}
      </p>
      <section className="moneyPanel" aria-labelledby="claims-terms">
        <header>
          <h3 id="claims-terms">Terms</h3>
        </header>
        <form className="moneyBody" onSubmit={saveTerms}>
          <p className="helpText">
            What the rate confirmation or agreement says. Free time starts at
            the later of arrival and the opening of the appointment window.
            {hasOpen && " Terms are locked while a claim is open."}
          </p>
          {data?.terms?.source === "rate_confirmation" && (
            <p className="helpText">
              {data.terms.source_document
                ? `Taken from ${data.terms.source_document.filename} (version ${data.terms.source_document.version}), the accepted rate confirmation.`
                : "Not tied to a rate confirmation file."}
            </p>
          )}
          <div className="formGrid">
            <label>
              <span>Free time (minutes)</span>
              <input
                inputMode="numeric"
                value={form.free}
                onChange={(e) => setForm({ ...form, free: e.target.value })}
              />
            </label>
            <label>
              <span>Detention per hour ($)</span>
              <input
                inputMode="decimal"
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
              />
            </label>
            <label>
              <span>Most paid (minutes, optional)</span>
              <input
                inputMode="numeric"
                value={form.cap}
                onChange={(e) => setForm({ ...form, cap: e.target.value })}
              />
            </label>
            <label>
              <span>TONU fee ($, optional)</span>
              <input
                inputMode="decimal"
                value={form.tonu}
                onChange={(e) => setForm({ ...form, tonu: e.target.value })}
              />
            </label>
            <label>
              <span>Where the terms come from</span>
              <select
                value={form.source}
                onChange={(e) =>
                  setForm({
                    ...form,
                    source: e.target.value as ClaimTerms["source"],
                  })
                }
              >
                {Object.entries(sourceLabels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="formActions">
            <button
              type="submit"
              className="primary"
              disabled={offline || busy || hasOpen}
            >
              Save terms
            </button>
          </div>
        </form>
      </section>
      <section className="moneyPanel" aria-labelledby="claims-detention">
        <header>
          <h3 id="claims-detention">Detention by stop</h3>
        </header>
        <div className="moneyBody">
          {data?.detention.map((d) => (
            <article
              key={d.stop.id}
              className="claimCard"
              aria-label={`Stop ${d.stop.sequence}`}
            >
              <h4>
                Stop {d.stop.sequence}: {d.stop.kind} at {d.stop.address}
              </h4>
              {d.calc.complete ? (
                <p>
                  {d.calc.dwell_minutes} minutes counted, {d.calc.free_minutes}{" "}
                  free, <strong>{d.calc.billable_minutes} billable</strong>
                  {d.calc.capped ? " (capped)" : ""} ={" "}
                  <strong>{formatMoney(d.calc.amount_minor)}</strong>
                </p>
              ) : (
                <p className="helpText">
                  {d.calc.issues
                    .filter((i) => i === "no_terms" || i.startsWith("not_"))
                    .map((i) => issueLabels[i])
                    .join(". ") || "Not enough recorded yet."}
                </p>
              )}
              {d.calc.issues.some(
                (i) => !i.startsWith("not_") && i !== "no_terms",
              ) && (
                <p className="helpText">
                  Noted on the claim:{" "}
                  {d.calc.issues
                    .filter((i) => !i.startsWith("not_") && i !== "no_terms")
                    .map((i) => issueLabels[i])
                    .join("; ")}
                </p>
              )}
              {d.calc.complete &&
                BigInt(d.calc.amount_minor) > 0n &&
                !open(d.stop.id, "detention") && (
                  <div className="formActions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={offline || busy}
                      onClick={() => void start("detention", d.stop.id)}
                    >
                      Start detention claim
                      <span className="srOnly">
                        {" "}
                        for stop {d.stop.sequence}
                      </span>
                    </button>
                  </div>
                )}
            </article>
          ))}
        </div>
      </section>
      <section className="moneyPanel" aria-labelledby="claims-tonu">
        <header>
          <h3 id="claims-tonu">Truck ordered not used</h3>
        </header>
        <div className="moneyBody">
          {data?.tonu.eligible ? (
            <>
              <p>
                This load was cancelled after dispatch.{" "}
                {data.tonu.amount_minor
                  ? `The terms state a fee of ${formatMoney(data.tonu.amount_minor)}.`
                  : "Add the TONU fee from the rate confirmation in the terms."}
              </p>
              {data.tonu.amount_minor && !open(null, "tonu") && (
                <div className="formActions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={offline || busy}
                    onClick={() => void start("tonu")}
                  >
                    Start TONU claim
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="helpText">{data?.tonu.reason}</p>
          )}
        </div>
      </section>
      <section className="moneyPanel" aria-labelledby="claims-list">
        <header>
          <h3 id="claims-list">Claims</h3>
        </header>
        <div className="moneyBody">
          {data && !data.claims.length && (
            <p className="helpText">No claims on this load yet.</p>
          )}
          {data?.claims.map((c) => {
            const [label, tone] = statusLabels[c.status];
            return (
              <article
                key={c.id}
                className="claimCard"
                aria-label={`${c.kind === "tonu" ? "TONU" : "Detention"} claim`}
              >
                <h4>
                  {c.kind === "tonu" ? "TONU" : "Detention"}{" "}
                  {formatMoney(c.claimed_minor)}{" "}
                  <StatusBadge tone={tone}>{label}</StatusBadge>
                </h4>
                <p className="helpText">
                  Started {formatDateTime(c.created_at)}
                  {c.submitted_at && `, sent ${formatDateTime(c.submitted_at)}`}
                  {c.settled_minor !== null &&
                    `, paid ${formatMoney(c.settled_minor)}`}
                  {c.outcome_note && `. ${c.outcome_note}`}
                </p>
                <div className="formActions">
                  <a
                    className="secondary"
                    href={`/api/claims/${c.id}/packet`}
                    download
                  >
                    Download packet
                  </a>
                  {c.status === "draft" && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={offline || busy}
                        onClick={() =>
                          void run(
                            () =>
                              api(`claims/${c.id}/refresh`, {
                                version: c.version,
                              }),
                            "Evidence refreshed from the times recorded now.",
                          )
                        }
                      >
                        Refresh evidence
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={offline || busy}
                        onClick={() =>
                          void run(
                            () =>
                              api(`claims/${c.id}/submit`, {
                                version: c.version,
                              }),
                            "Recorded as sent. The evidence is now fixed.",
                          )
                        }
                      >
                        I sent it
                      </button>
                    </>
                  )}
                  {c.status === "submitted" && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={offline || busy}
                        onClick={() =>
                          setSettle({
                            id: c.id,
                            amount: minorToDollars(c.claimed_minor),
                          })
                        }
                      >
                        Record payment
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={offline || busy}
                        onClick={() =>
                          void run(
                            () =>
                              api(`claims/${c.id}/outcome`, {
                                version: c.version,
                                outcome: "denied",
                                note: "",
                              }),
                            "Recorded as denied.",
                          )
                        }
                      >
                        Denied
                      </button>
                    </>
                  )}
                </div>
                {settle?.id === c.id && (
                  <form
                    className="moneyBar"
                    onSubmit={(e) => {
                      e.preventDefault();
                      let amount: number;
                      try {
                        amount = dollarsToMinor(settle.amount);
                      } catch (err) {
                        return setError(
                          err instanceof Error
                            ? err.message
                            : "VALIDATION_ERROR",
                        );
                      }
                      setSettle(null);
                      void run(
                        () =>
                          api(`claims/${c.id}/outcome`, {
                            version: c.version,
                            outcome: "paid",
                            settled_minor: amount,
                            note: "",
                          }),
                        "Payment recorded.",
                      );
                    }}
                  >
                    <label>
                      <span>Amount received ($)</span>
                      <input
                        autoFocus
                        inputMode="decimal"
                        value={settle.amount}
                        onChange={(e) =>
                          setSettle({ id: c.id, amount: e.target.value })
                        }
                      />
                    </label>
                    <button type="submit" className="primary">
                      Save payment
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setSettle(null)}
                    >
                      Cancel
                    </button>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
