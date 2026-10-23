"use client";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { ErrorAlert, PageIntro } from "@/components/ui/feedback";

type Account = {
  name: string;
  email: string;
  phone?: string;
  sms_opt_in?: boolean;
  email_verified: boolean;
  mfa_enabled: boolean;
  mfa_available: boolean;
  recovery_codes_remaining: number;
};

const tabs = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
] as const;
type Tab = (typeof tabs)[number]["id"];

export function AccountSettings({
  onAuthError,
}: {
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [account, setAccount] = useState<Account | null>(null),
    [setup, setSetup] = useState<{
      secret: string;
      otpauth_uri: string;
    } | null>(null),
    [codes, setCodes] = useState<string[] | null>(null),
    [disabling, setDisabling] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<Tab>("profile");
  const load = useCallback(async () => {
    try {
      setAccount(await api<Account>("account"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    }
  }, [api, onAuthError]);
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
    <section
      className="carrierDirectory accountPage"
      aria-label="Account settings"
    >
      <PageIntro title="Account and security">
        {account && `${account.name} · ${account.email}`}
      </PageIntro>
      <ErrorAlert error={error} />
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice}
      </p>
      {account && (
        <>
          <Tabs
            label="Account"
            idPrefix="account"
            items={tabs}
            value={tab}
            onChange={setTab}
          />
          <TabPanel idPrefix="account" value={tab} className="billingColumns">
            <div className="opsList">
              {tab === "profile" && (
                <form
                  className="opsCard opsForm"
                  aria-label="Profile"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void act(async () => {
                      await api("account/profile", {
                        name: String(f.get("name")).trim(),
                        phone: String(f.get("phone")).trim(),
                        sms_opt_in: f.get("sms_opt_in") === "on",
                      });
                      return "Profile saved.";
                    });
                  }}
                >
                  <h3>Profile</h3>
                  <label>
                    Name
                    <input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={account.name}
                    />
                  </label>
                  <label>
                    Phone{" "}
                    <small>(shown to teammates so they can reach you)</small>
                    <input
                      name="phone"
                      type="tel"
                      maxLength={40}
                      autoComplete="tel"
                      defaultValue={account.phone || ""}
                    />
                  </label>
                  <label className="setupCheckbox">
                    <input
                      type="checkbox"
                      name="sms_opt_in"
                      defaultChecked={account.sms_opt_in}
                    />
                    <span>
                      Teammates may text me from Relay (message rates may apply;
                      untick to stop)
                    </span>
                  </label>
                  <button className="secondary" disabled={busy}>
                    Save profile
                  </button>
                </form>
              )}
              {tab === "security" && (
                <form
                  className="opsCard opsForm"
                  aria-label="Change password"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const f = new FormData(form);
                    if (f.get("new_password") !== f.get("confirm")) {
                      setError("The new passwords don't match.");
                      return;
                    }
                    const ok = await act(async () => {
                      await api("account/password", {
                        current_password: String(f.get("current_password")),
                        new_password: String(f.get("new_password")),
                      });
                      return "Password changed. Other sessions were signed out.";
                    });
                    if (ok) form.reset();
                  }}
                >
                  <h3>Change password</h3>
                  <label>
                    Current password
                    <input
                      name="current_password"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={256}
                    />
                  </label>
                  <label>
                    New password
                    <input
                      name="new_password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      required
                    />
                  </label>
                  <label>
                    Confirm new password
                    <input
                      name="confirm"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      required
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Change password
                  </button>
                </form>
              )}
            </div>
            <div className="opsList">
              {tab === "profile" && (
                <article className="opsCard">
                  <div className="opsCardHeading">
                    <h3>Email address</h3>
                    <span
                      className={
                        "opsPill " + (account.email_verified ? "good" : "warn")
                      }
                    >
                      {account.email_verified ? "Verified" : "Not verified"}
                    </span>
                  </div>
                  <p className="opsMeta">
                    Password reset links and notifications go to {account.email}
                    .
                  </p>
                  {!account.email_verified && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api("account/verify-email/request", {});
                          return "Verification link sent if email delivery is configured. It expires in 24 hours.";
                        })
                      }
                    >
                      Send verification email
                    </button>
                  )}
                </article>
              )}
              {tab === "security" && (
                <article className="opsCard">
                  <div className="opsCardHeading">
                    <ShieldCheckIcon size={16} aria-hidden="true" />
                    <h3>Two-step verification</h3>
                    <span
                      className={
                        "opsPill " + (account.mfa_enabled ? "good" : "")
                      }
                    >
                      {account.mfa_enabled ? "On" : "Off"}
                    </span>
                  </div>
                  {codes ? (
                    <>
                      <p className="opsMeta">
                        Save these recovery codes somewhere safe. Each works
                        once if you lose your authenticator. They won&apos;t be
                        shown again.
                      </p>
                      <ul className="recoveryCodes" aria-label="Recovery codes">
                        {codes.map((c) => (
                          <li key={c}>
                            <code>{c}</code>
                          </li>
                        ))}
                      </ul>
                      <button
                        className="primary"
                        onClick={() => setCodes(null)}
                      >
                        I saved my recovery codes
                      </button>
                    </>
                  ) : account.mfa_enabled ? (
                    <>
                      <p className="opsMeta">
                        Sign-in asks for a code from your authenticator app.{" "}
                        {account.recovery_codes_remaining} recovery codes
                        remain.
                      </p>
                      {disabling ? (
                        <form
                          className="opsForm"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            const ok = await act(async () => {
                              await api("account/mfa/disable", {
                                password: String(f.get("password")),
                                code: String(f.get("code")).trim(),
                              });
                              return "Two-step verification turned off.";
                            });
                            if (ok) setDisabling(false);
                          }}
                        >
                          <label>
                            Password
                            <input
                              name="password"
                              type="password"
                              autoComplete="current-password"
                              required
                            />
                          </label>
                          <label>
                            Authentication or recovery code
                            <input
                              name="code"
                              autoComplete="one-time-code"
                              required
                              maxLength={40}
                            />
                          </label>
                          <div className="opsActions">
                            <button className="primary" disabled={busy}>
                              Turn off
                            </button>
                            <button
                              type="button"
                              className="textButton"
                              onClick={() => setDisabling(false)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          className="textButton"
                          onClick={() => setDisabling(true)}
                        >
                          Turn off two-step verification
                        </button>
                      )}
                    </>
                  ) : !account.mfa_available ? (
                    <p className="opsMeta">{describe("MFA_UNAVAILABLE")}</p>
                  ) : setup ? (
                    <form
                      className="opsForm"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const code = String(
                          new FormData(e.currentTarget).get("code"),
                        ).trim();
                        await act(async () => {
                          const r = await api<{ recovery_codes: string[] }>(
                            "account/mfa/enable",
                            { code },
                          );
                          setSetup(null);
                          setCodes(r.recovery_codes);
                          return "Two-step verification is on.";
                        });
                      }}
                    >
                      <p className="opsMeta">
                        Add Relay to an authenticator app with this setup key,
                        or{" "}
                        <a href={setup.otpauth_uri}>open it on this device</a>.
                      </p>
                      <p>
                        <code className="mfaSecret" aria-label="Setup key">
                          {setup.secret.match(/.{1,4}/g)?.join(" ")}
                        </code>
                      </p>
                      <label>
                        6-digit code from the app
                        <input
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="\d{6}"
                          required
                          maxLength={6}
                        />
                      </label>
                      <button className="primary" disabled={busy}>
                        Turn on
                      </button>
                    </form>
                  ) : (
                    <>
                      <p className="opsMeta">
                        Protect your account with a code from an authenticator
                        app at sign-in.
                      </p>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setSetup(
                              await api<{
                                secret: string;
                                otpauth_uri: string;
                              }>("account/mfa/setup", {}),
                            );
                          })
                        }
                      >
                        Set up two-step verification
                      </button>
                    </>
                  )}
                </article>
              )}
            </div>
          </TabPanel>
        </>
      )}
    </section>
  );
}
