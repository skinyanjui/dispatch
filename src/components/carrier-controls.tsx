"use client";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ErrorAlert } from "@/components/ui/feedback";
import { ApiError, useApi } from "@/lib/client-api";
import { flagLabels, type AuthorityState } from "@/lib/authority-state";
import { formatDateTime } from "@/lib/format";
import type {
  AuthorityStatus,
  ChangeControl,
  SensitiveChange,
} from "@/lib/money-types";

const stateLabel: Record<AuthorityState, [string, StatusTone]> = {
  unchecked: ["Not checked yet", "neutral"],
  clear: ["Nothing found", "good"],
  attention: ["Needs a person", "bad"],
  unverified: ["Could not confirm", "warn"],
};
const methods: Record<string, string> = {
  ach: "ACH",
  wire: "Wire",
  check: "Check",
  factor: "Factor",
};
const verifications: [string, string][] = [
  ["callback", "I called a number already on record"],
  ["document", "I checked a signed document"],
  ["in_person", "I confirmed in person"],
];

function useFail(onAuthError: (e: unknown) => void) {
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      return e instanceof Error ? e.message : "SERVICE_UNAVAILABLE";
    },
    [onAuthError],
  );
}

/** What the public registry last said about this carrier, with where and when (ADR 0065). */
export function CarrierRegistration({
  carrierId,
  offline,
  onAuthError,
}: {
  carrierId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const fail = useFail(onAuthError);
  const [data, setData] = useState<AuthorityStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<AuthorityStatus>("authority?carrier_id=" + carrierId));
      setError("");
    } catch (e) {
      setError(fail(e));
    }
  }, [api, carrierId, fail]);
  useEffect(() => {
    // Fetch per carrier; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function check() {
    setBusy(true);
    try {
      setData(
        await api<AuthorityStatus>("authority/check", {
          carrier_id: carrierId,
          key: crypto.randomUUID(),
        }),
      );
      setError("");
    } catch (e) {
      setError(fail(e));
    } finally {
      setBusy(false);
    }
  }
  const [label, tone] = data
    ? stateLabel[data.state]
    : ["Loading", "neutral" as StatusTone];
  return (
    <section className="moneyPanel" aria-labelledby="reg-title">
      <header>
        <h3 id="reg-title">Public registration</h3>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </header>
      <div className="moneyBody">
        {error && <ErrorAlert error={error} onRetry={() => void load()} />}
        {data && (
          <>
            <dl className="moneyFacts">
              <div>
                <dt>USDOT number</dt>
                <dd>{data.usdot || "Not on file"}</dd>
              </div>
              <div>
                <dt>MC number</dt>
                <dd>{data.mc_number || "Not on file"}</dd>
              </div>
              <div>
                <dt>Registered name</dt>
                <dd>{data.legal_name || "—"}</dd>
              </div>
              <div>
                <dt>Last looked up</dt>
                <dd>
                  {data.observed_at
                    ? `${formatDateTime(data.observed_at)} (${data.age_hours === 0 ? "just now" : `${data.age_hours} h ago`}) from ${data.source === "fixture" ? "sample data, not the registry" : "the FMCSA public service"}`
                    : "Never"}
                </dd>
              </div>
            </dl>
            {data.flags.length > 0 && (
              <ul className="flagList" aria-label="What was found">
                {data.flags.map((f) => (
                  <li key={f}>{flagLabels[f]}</li>
                ))}
              </ul>
            )}
            <p className="helpText">
              A registry can be late or wrong. This is a prompt to look, not a
              ruling; nothing is blocked automatically.
            </p>
            <div className="formActions">
              <button
                type="button"
                className="secondary"
                disabled={offline || busy || !data.usdot || !data.provider}
                onClick={() => void check()}
              >
                {busy ? "Checking…" : "Check now"}
              </button>
              {!data.usdot && (
                <span className="helpText">
                  Add the USDOT number in carrier setup first.
                </span>
              )}
              {data.usdot && !data.provider && (
                <span className="helpText">
                  Lookups are not set up on this server yet.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const showValue = (v: unknown) => {
  const o = (v ?? {}) as Record<string, string>;
  return o.payee_name
    ? `${o.payee_name}, ${methods[o.method] ?? o.method}${o.account_last4 ? `, account ending ${o.account_last4}` : ""}`
    : "";
};

/** Payout details and the changes that wait for a second person (ADR 0064). */
export function PayoutApprovals({
  carrierId,
  offline,
  onAuthError,
}: {
  carrierId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const fail = useFail(onAuthError);
  const [data, setData] = useState<ChangeControl | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [asking, setAsking] = useState(false),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState({
      payee_name: "",
      method: "ach",
      account_last4: "",
      reason: "",
    }),
    [deciding, setDeciding] = useState<{
      change: SensitiveChange;
      verification: string;
      note: string;
      password: string;
      code: string;
    } | null>(null);
  const load = useCallback(async () => {
    try {
      setData(
        await api<ChangeControl>("change-control?carrier_id=" + carrierId),
      );
      setError("");
    } catch (e) {
      setError(fail(e));
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
      setError(fail(e));
    } finally {
      setBusy(false);
    }
  }
  const pending = (data?.changes ?? []).filter((c) => c.status === "pending");
  const recent = (data?.changes ?? [])
    .filter((c) => c.status !== "pending")
    .slice(0, 5);
  const current = data?.payout_details;
  return (
    <section className="moneyPanel" aria-labelledby="payout-title">
      <header>
        <h3 id="payout-title">Payout details and approvals</h3>
        <button
          type="button"
          className="secondary"
          disabled={offline || busy || !data}
          onClick={() => setAsking((a) => !a)}
          aria-expanded={asking}
        >
          Change payout details
        </button>
      </header>
      <div className="moneyBody">
        {error && <ErrorAlert error={error} onRetry={() => void load()} />}
        <p
          className={notice ? "inlineNotice" : "srOnly"}
          role="status"
          aria-live="polite"
        >
          {notice}
        </p>
        {data && (
          <>
            <p>
              {current ? (
                <>
                  Paid to <strong>{showValue(current)}</strong>.{" "}
                  {current.cooling_off
                    ? `These are new and still cooling off until ${formatDateTime(current.effective_at)}.`
                    : "In force."}
                </>
              ) : (
                "No payout details on file."
              )}
            </p>
            <p className="helpText">
              Payout details, a carrier contact&apos;s phone or email, and a
              stop address after dispatch are what impostors change. Each change
              waits for a different person from the carrier or the organization
              to approve it after confirming it another way. Approved payout
              details wait {data.cooling_hours} hours before they count. Account
              numbers are never stored, only the last four digits.
            </p>
          </>
        )}
        {asking && (
          <form
            className="changeItem"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api("change-control/payout-details", {
                    carrier_id: carrierId,
                    ...form,
                    key: crypto.randomUUID(),
                  }),
                "Requested. A second person needs to approve it before it counts.",
              ).then(() => {
                setAsking(false);
                setForm({
                  payee_name: "",
                  method: "ach",
                  account_last4: "",
                  reason: "",
                });
              });
            }}
          >
            <div className="formGrid">
              <label>
                <span>Payee name</span>
                <input
                  required
                  maxLength={160}
                  value={form.payee_name}
                  onChange={(e) =>
                    setForm({ ...form, payee_name: e.target.value })
                  }
                />
              </label>
              <label>
                <span>How they are paid</span>
                <select
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value })}
                >
                  {Object.entries(methods).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Last four digits (optional)</span>
                <input
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={form.account_last4}
                  onChange={(e) =>
                    setForm({ ...form, account_last4: e.target.value })
                  }
                />
              </label>
              <label>
                <span>Why it is changing</span>
                <input
                  required
                  maxLength={500}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </label>
            </div>
            <div className="formActions">
              <button type="submit" className="primary" disabled={busy}>
                Ask for approval
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {pending.map((c) => (
          <article key={c.id} className="changeItem" aria-label={c.summary}>
            <h4>{c.summary}</h4>
            <p className="helpText">
              Asked by {c.requested_by_name} on {formatDateTime(c.requested_at)}
              : {c.reason}
            </p>
            {c.kind === "payout_details" && (
              <p>
                From {showValue(c.current) || "nothing on file"} to{" "}
                {showValue(c.proposed)}.
              </p>
            )}
            <div className="formActions">
              {c.can_decide && (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={offline || busy}
                    onClick={() =>
                      setDeciding({
                        change: c,
                        verification: "callback",
                        note: "",
                        password: "",
                        code: "",
                      })
                    }
                  >
                    Review<span className="srOnly"> {c.summary}</span>
                  </button>
                </>
              )}
              {c.can_cancel && (
                <button
                  type="button"
                  className="secondary"
                  disabled={offline || busy}
                  onClick={() =>
                    void run(
                      () => api(`change-control/${c.id}/cancel`, {}),
                      "Request withdrawn.",
                    )
                  }
                >
                  Withdraw
                </button>
              )}
              {!c.can_decide && !c.can_cancel && (
                <span className="helpText">
                  Waiting for someone from the carrier or organization.
                </span>
              )}
            </div>
          </article>
        ))}
        {deciding && (
          <form
            className="changeItem"
            aria-label={"Decide: " + deciding.change.summary}
            onSubmit={(e) => e.preventDefault()}
          >
            <h4>Before you approve: {deciding.change.summary}</h4>
            <p className="helpText">
              Confirm it another way than the request itself, such as calling a
              number you already had.
            </p>
            <label>
              <span>How you confirmed it</span>
              <select
                value={deciding.verification}
                onChange={(e) =>
                  setDeciding({ ...deciding, verification: e.target.value })
                }
              >
                {verifications.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Your password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                value={deciding.password}
                onChange={(e) =>
                  setDeciding({ ...deciding, password: e.target.value })
                }
              />
            </label>
            <label>
              <span>Authenticator or recovery code</span>
              <input
                autoComplete="one-time-code"
                maxLength={40}
                value={deciding.code}
                onChange={(e) =>
                  setDeciding({ ...deciding, code: e.target.value })
                }
              />
              <small>Only if you use two-step verification.</small>
            </label>
            <label>
              <span>Note (optional)</span>
              <input
                maxLength={500}
                value={deciding.note}
                onChange={(e) =>
                  setDeciding({ ...deciding, note: e.target.value })
                }
              />
            </label>
            <div className="formActions">
              <button
                type="button"
                className="primary"
                disabled={busy || !deciding.password}
                onClick={() => {
                  const d = deciding;
                  // Kept open on failure so a mistyped password can be retried.
                  void run(
                    () =>
                      api(`change-control/${d.change.id}/decision`, {
                        decision: "approve",
                        verification: d.verification,
                        note: d.note,
                        password: d.password,
                        ...(d.code.trim() ? { code: d.code.trim() } : {}),
                      }).then((r) => {
                        setDeciding(null);
                        return r;
                      }),
                    "Approved.",
                  );
                }}
              >
                Approve
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  const d = deciding;
                  setDeciding(null);
                  void run(
                    () =>
                      api(`change-control/${d.change.id}/decision`, {
                        decision: "reject",
                        note: d.note,
                      }),
                    "Rejected. Nothing changed.",
                  );
                }}
              >
                Reject
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setDeciding(null)}
              >
                Not now
              </button>
            </div>
          </form>
        )}
        {recent.length > 0 && (
          <details>
            <summary>Recent decisions</summary>
            <ul className="flagList">
              {recent.map((c) => (
                <li key={c.id}>
                  {c.summary}:{" "}
                  {c.status === "approved"
                    ? `approved by ${c.decided_by_name}`
                    : c.status === "rejected"
                      ? `rejected by ${c.decided_by_name}`
                      : c.status === "cancelled"
                        ? c.expired
                          ? "lapsed without a decision"
                          : "withdrawn"
                        : "out of date when approved"}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
