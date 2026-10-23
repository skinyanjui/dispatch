"use client";
import { useCallback, useEffect, useState } from "react";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { ApiError, useApi } from "@/lib/client-api";
import {
  notificationLabels,
  optionalKinds,
  type NotificationLogEntry,
  type OptionalKind,
} from "@/lib/notification-kinds";
import { ErrorAlert, PageIntro } from "@/components/ui/feedback";
import { formatDateTimeLong, formatTime } from "@/lib/format";

const transportLabels: Record<string, string> = {
  none: "Not configured — messages are recorded but not emailed",
  log: "Development log — messages are recorded on the server, not emailed",
  resend: "Email provider connected",
  demo: "Demo — nothing is sent from this device",
};
const statusLabels: Record<NotificationLogEntry["status"], string> = {
  pending: "Queued",
  sent: "Accepted by provider",
  delivered: "Delivery confirmed",
  failed: "Failed",
  suppressed: "Not sent",
};

export function NotificationCenter({
  isDispatcher,
  driverOnly,
  onAuthError,
}: {
  isDispatcher: boolean;
  driverOnly: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [prefs, setPrefs] = useState<Record<OptionalKind, boolean> | null>(
      null,
    ),
    [log, setLog] = useState<{
      transport: string;
      notifications: NotificationLogEntry[];
    } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [shown, setShown] = useState(20);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [p, l] = await Promise.all([
        api<Record<OptionalKind, boolean>>("notifications/preferences"),
        isDispatcher
          ? api<{ transport: string; notifications: NotificationLogEntry[] }>(
              "notifications",
            )
          : Promise.resolve(null),
      ]);
      setPrefs(p);
      setLog(l);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }, [api, isDispatcher, onAuthError]);
  useEffect(() => {
    // Initial fetch; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice(await fn());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  const visibleKinds = optionalKinds.filter(
    (k) =>
      k === "message_received" ||
      (driverOnly
        ? k === "assignment" || k === "appointment_reminder"
        : k !== "assignment" && k !== "appointment_reminder"),
  );
  return (
    <section
      className="carrierDirectory notificationPage"
      aria-label="Notifications"
    >
      <PageIntro title="Notifications">
        Invitations, assignment updates and reminders are emailed automatically
        when email delivery is configured.
      </PageIntro>
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice || (busy ? "Loading notifications" : "")}
      </p>
      {prefs && (
        <fieldset className="opsCard opsChecklist" disabled={busy}>
          <legend>Email me about</legend>
          {visibleKinds.map((kind) => (
            <label key={kind} className="setupCheckbox">
              <input
                type="checkbox"
                checked={prefs[kind]}
                onChange={(e) => {
                  const email = e.target.checked;
                  void act(async () => {
                    setPrefs(
                      await api<Record<OptionalKind, boolean>>(
                        "notifications/preferences",
                        { kind, email },
                      ),
                    );
                    return `${notificationLabels[kind]} ${email ? "on" : "off"}.`;
                  });
                }}
              />
              <span>{notificationLabels[kind]}</span>
            </label>
          ))}
          <small>
            Invitations, password resets and email verification are always sent.
          </small>
        </fieldset>
      )}
      {log && (
        <>
          <h3>Delivery log</h3>
          <p className="helpText">
            Email delivery: {transportLabels[log.transport] || log.transport}.
            Message content is encrypted while queued and removed after
            delivery.
          </p>
          {log.notifications.length ? (
            <div className="opsList">
              {log.notifications.slice(0, shown).map((n) => (
                <article className="opsCard" key={n.id}>
                  <div className="opsCardHeading">
                    <EnvelopeSimpleIcon size={16} aria-hidden="true" />
                    <h3>{n.subject}</h3>
                    <span
                      className={
                        "opsPill " +
                        (n.status === "sent" || n.status === "delivered"
                          ? "good"
                          : n.status === "failed"
                            ? "bad"
                            : "warn")
                      }
                    >
                      {statusLabels[n.status]}
                      {n.provider === "log" && n.status === "sent"
                        ? " (log only)"
                        : ""}
                    </span>
                  </div>
                  <p className="opsMeta">
                    {notificationLabels[n.kind]} · To {n.recipient_email} ·{" "}
                    {formatDateTimeLong(n.created_at)} · Attempts {n.attempts}
                    {n.status === "pending" &&
                      n.attempts > 0 &&
                      ` · Next try ${formatTime(n.next_attempt_at)}`}
                    {n.last_error && <> · {n.last_error}</>}
                  </p>
                  {n.retryable && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(`notifications/${n.id}/retry`, {});
                          await load();
                          return "Message queued for another attempt.";
                        })
                      }
                    >
                      Retry delivery
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="helpText">No messages yet.</p>
          )}
          {log.notifications.length > shown && (
            <button
              type="button"
              className="secondary notificationMore"
              onClick={() => setShown((n) => n + 20)}
            >
              Show more ({log.notifications.length - shown} more)
            </button>
          )}
        </>
      )}
    </section>
  );
}
