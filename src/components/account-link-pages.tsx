"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { Brand } from "@/components/workspace-shell";
import { ApiError, describe, useApi } from "@/lib/client-api";

// Tokens arrive in the URL fragment so they never reach server logs or
// Referer headers; they are posted in the request body.
function useFragmentToken() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const value = window.location.hash.slice(1);
    // Read once on mount; the fragment is not available during prerender.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(/^[a-f0-9]{64}$/.test(value) ? value : "");
    history.replaceState(null, "", window.location.pathname);
  }, []);
  return token;
}

export function ResetPasswordPage() {
  const api = useApi();
  const token = useFragmentToken();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <main className="login joinPage">
      <Brand />
      <section className="loginPanel">
        {token === null ? (
          <p role="status">Opening your reset link…</p>
        ) : done ? (
          <>
            <CheckCircleIcon className="joinSuccess" size={42} />
            <h1>Password updated.</h1>
            <p className="setupIntro">
              You were signed out everywhere. Sign in with your new password.
            </p>
            <Link className="primary full setupLink" href="/">
              Sign in <ArrowRightIcon size={16} aria-hidden="true" />
            </Link>
          </>
        ) : !token ? (
          <>
            <h1>Link unavailable.</h1>
            <p className="setupIntro">{describe("TOKEN_UNAVAILABLE")}</p>
            <Link className="secondary" href="/">
              Back to sign in
            </Link>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (f.get("password") !== f.get("confirm")) {
                setError("The passwords don't match.");
                return;
              }
              setBusy(true);
              setError("");
              try {
                await api("password-reset/complete", {
                  token,
                  password: String(f.get("password")),
                });
                setDone(true);
              } catch (err) {
                setError(
                  err instanceof ApiError ? err.message : "SERVICE_UNAVAILABLE",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="eyebrow">ACCOUNT RECOVERY</p>
            <h1>Choose a new password.</h1>
            <label>
              New password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
              />
              <small>At least 12 characters.</small>
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
            {error && (
              <div className="alert error" role="alert">
                {describe(error)}
              </div>
            )}
            <button className="primary full" disabled={busy}>
              {busy ? "Saving…" : "Update password"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export function VerifyEmailPage() {
  const api = useApi();
  const token = useFragmentToken();
  const [state, setState] = useState<"working" | "done" | string>("working");
  useEffect(() => {
    if (token === null) return;
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState("TOKEN_UNAVAILABLE");
      return;
    }
    api("account/verify-email/complete", { token })
      .then(() => setState("done"))
      .catch((e) =>
        setState(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE"),
      );
  }, [api, token]);
  return (
    <main className="login joinPage">
      <Brand />
      <section className="loginPanel">
        {state === "working" ? (
          <p role="status">Confirming your email…</p>
        ) : state === "done" ? (
          <>
            <CheckCircleIcon className="joinSuccess" size={42} />
            <h1 role="status">Email confirmed.</h1>
            <Link className="primary full setupLink" href="/">
              Open Relay <ArrowRightIcon size={16} aria-hidden="true" />
            </Link>
          </>
        ) : (
          <>
            <h1>We couldn&apos;t confirm that link.</h1>
            <p className="setupIntro" role="alert">
              {describe(state)} You can send a new link from Account.
            </p>
            <Link className="secondary" href="/">
              Back to Relay
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
