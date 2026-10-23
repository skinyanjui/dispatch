"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, useApi } from "@/lib/client-api";
import { formatDateTimeLong } from "@/lib/format";
import { ErrorAlert } from "@/components/ui/feedback";

type Session = {
  id: string;
  created_at: string;
  expires_at: string;
  remember: boolean;
  current: boolean;
};

/** The person's signed-in sessions, with "sign out" for each other one. */
export function AccountSessions({
  onAuthError,
}: {
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [sessions, setSessions] = useState<Session[] | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    try {
      setError("");
      setSessions(
        (await api<{ sessions: Session[] }>("account/sessions")).sessions,
      );
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);
  useEffect(() => {
    // Initial fetch; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function end(path: string, message: string) {
    setBusy(true);
    setNotice("");
    try {
      await api(path, {});
      setNotice(message);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const others = sessions?.filter((s) => !s.current) ?? [];
  return (
    <article className="opsCard" aria-label="Signed-in sessions">
      <div className="opsCardHeading">
        <h3>Where you&apos;re signed in</h3>
      </div>
      <ErrorAlert error={error} onRetry={() => void load()} />
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice}
      </p>
      {sessions && (
        <>
          <ul className="opsList" aria-label="Sessions">
            {sessions.map((s) => (
              <li key={s.id}>
                <p>
                  {s.current ? "This device" : "Another device"}
                  {s.remember ? " · remembered" : ""}
                </p>
                <p className="opsMeta">
                  Signed in {formatDateTimeLong(s.created_at)} · ends{" "}
                  {formatDateTimeLong(s.expires_at)}
                </p>
                {!s.current && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void end(
                        `account/sessions/${s.id}/revoke`,
                        "That session was signed out.",
                      )
                    }
                  >
                    Sign out this session
                  </button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 0 ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void end(
                  "account/sessions/revoke-others",
                  "All other sessions were signed out.",
                )
              }
            >
              Sign out everywhere else
            </button>
          ) : (
            <p className="opsMeta">
              You&apos;re signed in on this device only.
            </p>
          )}
        </>
      )}
    </article>
  );
}
