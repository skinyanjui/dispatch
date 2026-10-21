"use client";
import { LoginHero } from "@/components/login-hero";
import { useEffect, useState } from "react";
import { Brand } from "@/components/workspace-shell";
import { useApi, ApiError, describe } from "@/lib/client-api";
import { ArrowRightIcon, CheckCircleIcon } from "@phosphor-icons/react";
type Invitation = {
  name: string;
  email: string;
  role: "driver" | "carrier-manager" | "dispatcher" | "admin";
  carrier_name: string;
  account_exists: boolean;
  signed_in: boolean;
  expires_at: string;
};
export function JoinWorkspace({ demo = false }: { demo?: boolean }) {
  const api = useApi();
  const [invitation, setInvitation] = useState<Invitation | null>(null),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [done, setDone] = useState(false),
    [visible, setVisible] = useState(false),
    [zone, setZone] = useState("UTC");
  useEffect(() => {
    const secret = window.location.hash.slice(1);
    const request = /^[a-f0-9]{64}$/.test(secret)
      ? api<Invitation>("onboarding/invitations/inspect", { token: secret })
      : Promise.reject(new ApiError(410, "INVITE_UNAVAILABLE"));
    request
      .then((d) => {
        setToken(secret);
        setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
        setInvitation(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setReady(true));
  }, [api]);
  return (
    <main className="login joinPage">
      <Brand />
      <section className="loginPanel">
        {!ready ? (
          <p role="status">Opening your invitation…</p>
        ) : done ? (
          <>
            <CheckCircleIcon className="joinSuccess" size={42} />
            <p className="eyebrow">YOU ARE READY</p>
            <h1>Welcome aboard.</h1>
            <p className="setupIntro">
              {invitation?.role === "driver"
                ? "Your assigned loads and check-ins are in one place. Your dispatcher will handle booking and assignments."
                : invitation?.role === "dispatcher" ||
                    invitation?.role === "admin"
                  ? "Your dispatch workspace is ready. Loads, exceptions and messages for your carriers are one click away."
                  : "Your carrier workspace is ready. Invite drivers when you are ready to bring the team in."}
            </p>
            <a
              className="primary full setupLink"
              href={
                (demo ? "/demo" : "/") +
                (invitation?.role === "carrier-manager" ? "?view=carriers" : "")
              }
            >
              {invitation?.role === "driver"
                ? "Open my loads"
                : invitation?.role === "dispatcher" ||
                    invitation?.role === "admin"
                  ? "Open workspace"
                  : "Open carrier workspace"}
              <ArrowRightIcon size={16} />
            </a>
          </>
        ) : invitation ? (
          <>
            <p className="eyebrow">
              {invitation.role === "driver"
                ? "DRIVER SETUP"
                : invitation.role === "carrier-manager"
                  ? "CARRIER SETUP"
                  : "TEAM SETUP"}
            </p>
            <h1>One step to join.</h1>
            <p className="setupIntro">
              {invitation.carrier_name} invited you as{" "}
              {
                {
                  driver: "a driver",
                  "carrier-manager": "a carrier manager",
                  dispatcher: "a dispatcher",
                  admin: "an administrator",
                }[invitation.role]
              }
              .
            </p>
            <div className="joinIdentity">
              <strong>{invitation.name}</strong>
              <span>{invitation.email}</span>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                const f = new FormData(e.currentTarget);
                setBusy(true);
                setError("");
                try {
                  if (invitation.account_exists && !invitation.signed_in)
                    await api("login", {
                      email: invitation.email,
                      password: String(f.get("password")),
                    });
                  await api("onboarding/invitations/accept", {
                    token,
                    name: String(f.get("name")),
                    ...(!invitation.account_exists
                      ? { password: String(f.get("password")) }
                      : {}),
                    phone: String(f.get("phone") || ""),
                    timezone: zone,
                  });
                  setDone(true);
                } catch (e) {
                  setError(
                    e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <fieldset className="setupFields" disabled={busy}>
                <legend className="srOnly">Join your carrier</legend>
                <label>
                  Your name
                  <input
                    name="name"
                    required
                    maxLength={120}
                    autoComplete="name"
                    defaultValue={invitation.name}
                  />
                </label>
                {(!invitation.account_exists || !invitation.signed_in) && (
                  <label>
                    {invitation.account_exists
                      ? "Your existing password"
                      : "Choose a password"}
                    <div className="joinPassword">
                      <input
                        name="password"
                        type={visible ? "text" : "password"}
                        required
                        minLength={invitation.account_exists ? 1 : 12}
                        maxLength={256}
                        autoComplete={
                          invitation.account_exists
                            ? "current-password"
                            : "new-password"
                        }
                      />
                      <button
                        type="button"
                        aria-pressed={visible}
                        onClick={() => setVisible(!visible)}
                      >
                        {visible ? "Hide" : "Show"}
                      </button>
                    </div>
                    <small>
                      {invitation.account_exists
                        ? "Use the password you already use for Relay."
                        : demo
                          ? "Use any 12 characters for this demo. Passwords are not saved."
                          : "Use at least 12 characters. You will use this to sign in."}
                    </small>
                  </label>
                )}
                {(invitation.role === "driver" ||
                  invitation.role === "dispatcher" ||
                  invitation.role === "admin") && (
                  <details className="setupOptional">
                    <summary>Contact details · optional</summary>
                    <label>
                      Phone
                      <input
                        name="phone"
                        type="tel"
                        maxLength={40}
                        autoComplete="tel"
                      />
                    </label>
                    <label>
                      Time zone
                      <select
                        value={zone}
                        onChange={(e) => setZone(e.target.value)}
                      >
                        {[
                          ...new Set([
                            zone,
                            "America/New_York",
                            "America/Chicago",
                            "America/Denver",
                            "America/Phoenix",
                            "America/Los_Angeles",
                            "America/Anchorage",
                            "Pacific/Honolulu",
                            "UTC",
                          ]),
                        ].map((z) => (
                          <option key={z}>{z}</option>
                        ))}
                      </select>
                    </label>
                  </details>
                )}
                {error && (
                  <div className="alert error" role="alert">
                    {describe(error)}
                  </div>
                )}
                <button className="primary full">
                  {busy
                    ? "Joining…"
                    : invitation.account_exists && !invitation.signed_in
                      ? "Sign in and join"
                      : "Join workspace"}
                  <ArrowRightIcon size={16} />
                </button>
              </fieldset>
            </form>
            <p className="setupIntro">
              {invitation.role === "driver"
                ? "You will only see loads assigned to you. No location is collected automatically."
                : "Your access is limited to this carrier. Dispatch authorization is reviewed separately."}
            </p>
          </>
        ) : (
          <>
            <h1>Let’s get you connected.</h1>
            <p className="setupIntro" role="alert">
              {describe(error || "INVITE_UNAVAILABLE")}
            </p>
            <a href={demo ? "/demo" : "/"} className="primary full setupLink">
              Go to sign in
              <ArrowRightIcon size={16} />
            </a>
          </>
        )}
      </section>
      <p className="loginBottom">A simpler start. A clearer handoff.</p>
      <LoginHero />
    </main>
  );
}
