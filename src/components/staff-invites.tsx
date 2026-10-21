"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, describe, useApi } from "@/lib/client-api";

type Invite = {
  id: string;
  name: string;
  email: string;
  role: "dispatcher" | "admin";
  carriers: string[];
  invited_by: string;
  expires_at: string;
  expired: boolean;
};

const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");

/** Invite dispatchers (owners and admins) and administrators (owners only). */
export function StaffInvites({
  organizationId,
  isOwner,
  carriers,
  demo = false,
  onAuthError,
}: {
  organizationId: string;
  isOwner: boolean;
  carriers: [string, string][];
  demo?: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [invites, setInvites] = useState<Invite[]>([]),
    [open, setOpen] = useState(false),
    [role, setRole] = useState<"dispatcher" | "admin">("dispatcher"),
    [link, setLink] = useState<{ url: string; name: string } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  // One retry identity (key and link secret) per unchanged submission.
  const attempt = useRef<{
    signature: string;
    key: string;
    token: string;
  } | null>(null);
  const load = useCallback(async () => {
    try {
      setInvites(
        (
          await api<{ invites: Invite[] }>(
            `organizations/${organizationId}/invites`,
          )
        ).invites,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    }
  }, [api, organizationId, onAuthError]);
  useEffect(() => {
    // Initial fetch; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      if (message) setNotice(message);
      await load();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="opsCard" aria-label="Team invitations">
      <div className="opsCardHeading">
        <h4>Invite teammates</h4>
        {!open && (
          <button className="secondary" onClick={() => setOpen(true)}>
            Invite
          </button>
        )}
      </div>
      {error && (
        <p className="alert error" role="alert">
          {describe(error)}
        </p>
      )}
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice}
      </p>
      {open && (
        <form
          className="opsForm"
          aria-label="Invite teammate"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = {
              name: String(f.get("name")).trim(),
              email: String(f.get("email")).trim(),
              role,
              carrier_ids: f.getAll("carrier").map(String),
            };
            const signature = JSON.stringify(body);
            if (attempt.current?.signature !== signature)
              attempt.current = {
                signature,
                key: crypto.randomUUID(),
                token: randomToken(),
              };
            const ok = await act(async () => {
              await api(`organizations/${organizationId}/invites`, {
                ...body,
                key: attempt.current!.key,
                token: attempt.current!.token,
              });
              setLink({
                url:
                  window.location.origin +
                  (demo ? "/demo/join#" : "/join#") +
                  attempt.current!.token,
                name: body.name,
              });
              attempt.current = null;
              return "Invitation created. An email is queued when email delivery is configured; you can also copy the private link.";
            });
            if (ok) {
              setOpen(false);
              (e.target as HTMLFormElement).reset?.();
            }
          }}
        >
          <div className="formGrid">
            <label>
              Name
              <input name="name" required maxLength={120} />
            </label>
            <label>
              Email
              <input name="email" type="email" required maxLength={254} />
            </label>
          </div>
          <label>
            Role
            <select
              value={role}
              onChange={(e) =>
                setRole(e.target.value as "dispatcher" | "admin")
              }
            >
              <option value="dispatcher">
                Dispatcher — works loads for chosen carriers
              </option>
              {isOwner && (
                <option value="admin">
                  Administrator — manages the organization and team
                </option>
              )}
            </select>
          </label>
          <fieldset className="opsChecklist">
            <legend>
              {role === "admin"
                ? "Also dispatch for (optional)"
                : "Carriers they will dispatch for"}
            </legend>
            {carriers.map(([id, name]) => (
              <label key={id} className="setupCheckbox">
                <input
                  type="checkbox"
                  name="carrier"
                  value={id}
                  defaultChecked={role === "dispatcher"}
                />
                <span>{name}</span>
              </label>
            ))}
          </fieldset>
          <div className="opsActions">
            <button className="primary" disabled={busy}>
              Create invitation
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {link && (
        <div className="opsForm">
          <label>
            Private invitation link for {link.name}
            <input
              readOnly
              value={link.url}
              aria-label="Invitation link"
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <small>
            Share it privately. It works once and expires in 7 days.
          </small>
          <div className="opsActions">
            <button
              className="secondary"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(link.url)
                  .then(() => setNotice("Link copied."))
              }
            >
              Copy link
            </button>
            <button className="textButton" onClick={() => setLink(null)}>
              Hide link
            </button>
          </div>
        </div>
      )}
      {invites.length > 0 && (
        <>
          <p className="sidebarLabel">Pending invitations</p>
          {invites.map((i) => (
            <div className="opsCardHeading" key={i.id}>
              <span className="opsTeamName">
                {i.name} · {i.role === "admin" ? "Administrator" : "Dispatcher"}
                <small>
                  {i.email}
                  {i.carriers.length > 0 && ` · ${i.carriers.join(", ")}`}
                  {i.expired ? " · expired" : ""}
                </small>
              </span>
              {(isOwner || i.role === "dispatcher") && (
                <button
                  className="textButton"
                  disabled={busy}
                  aria-label={`Revoke invitation for ${i.name}`}
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `organizations/${organizationId}/invites/${i.id}/revoke`,
                        {},
                      );
                      return `Invitation for ${i.name} revoked.`;
                    })
                  }
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </article>
  );
}
