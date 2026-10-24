"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { ApiError, api } from "@/lib/client-api";
import { legalVersion } from "@/lib/legal";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert } from "@/components/ui/feedback";

/**
 * The public "Request access" page (ADR 0034). Relay has no open sign-up: this
 * stores a request, creates nothing, and an administrator approves it.
 */
export function RequestAccess() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState("");
  // One identity per unchanged submission is not needed: a repeat of the same
  // email is harmless and answers the same way.
  const form = useRef<HTMLFormElement>(null);
  return (
    <AuthLayout
      className="joinPage"
      topRight={
        <>
          Already have an account? <Link href="/">Sign in</Link>
        </>
      }
    >
      <section className="loginPanel">
        {sent ? (
          <div role="status">
            <CheckCircleIcon
              className="joinSuccess"
              size={40}
              aria-hidden="true"
            />
            <h1>Request received</h1>
            <p className="loginDescription keep">
              A person reviews each request. If it is approved, a private link
              to set your password is sent to <strong>{sent}</strong>. Nothing
              has been created yet.
            </p>
            <Link className="primary full" href="/">
              Back to sign in
              <ArrowRightIcon size={16} aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <>
            <h1>Request access</h1>
            <p className="loginDescription">
              Tell us about your dispatch company. We review every request, and
              nothing is created until it is approved.
            </p>
            <form
              className="requestForm"
              ref={form}
              aria-label="Request access"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(true);
                setError("");
                try {
                  await api("access-requests", {
                    name: String(f.get("name")).trim(),
                    email: String(f.get("email")).trim(),
                    company: String(f.get("company")).trim(),
                    phone: String(f.get("phone")).trim(),
                    note: String(f.get("note")).trim(),
                    terms_accepted: f.get("terms") === "on",
                    terms_version: legalVersion,
                    website: String(f.get("website") ?? ""),
                  });
                  setSent(String(f.get("email")).trim());
                } catch (err) {
                  setError(
                    err instanceof ApiError
                      ? err.message
                      : "SERVICE_UNAVAILABLE",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="field">
                <label htmlFor="ra-name">Your name</label>
                <div className="fieldBox">
                  <input
                    id="ra-name"
                    name="name"
                    required
                    maxLength={120}
                    autoComplete="name"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="ra-email">Work email</label>
                <div className="fieldBox">
                  <input
                    id="ra-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    placeholder="you@work.com"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="ra-company">Company</label>
                <div className="fieldBox">
                  <input
                    id="ra-company"
                    name="company"
                    required
                    maxLength={160}
                    autoComplete="organization"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="ra-phone">Phone (optional)</label>
                <div className="fieldBox">
                  <input
                    id="ra-phone"
                    name="phone"
                    type="tel"
                    maxLength={40}
                    autoComplete="tel"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="ra-note">
                  Anything we should know (optional)
                </label>
                <div className="fieldBox tall">
                  <textarea id="ra-note" name="note" rows={2} maxLength={500} />
                </div>
              </div>
              {/* A field people never see: bots fill it in and are ignored. */}
              <div className="srOnly" aria-hidden="true">
                <label>
                  Website
                  <input name="website" tabIndex={-1} autoComplete="off" />
                </label>
              </div>
              <label className="rememberMe termsCheck">
                <input type="checkbox" name="terms" required />
                <span>
                  I have read the <a href="/terms">Terms</a> and{" "}
                  <a href="/privacy">Privacy</a> pages.
                </span>
              </label>
              <ErrorAlert error={error} />
              <button className="primary full" disabled={busy}>
                {busy ? "Sending…" : "Request access"}
                <ArrowRightIcon size={16} aria-hidden="true" />
              </button>
            </form>
          </>
        )}
      </section>
    </AuthLayout>
  );
}
