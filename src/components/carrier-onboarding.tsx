"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  XIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CopyIcon,
  PlusIcon,
  BuildingsIcon,
} from "@phosphor-icons/react";
import type { CarrierDocuments, CarrierSetup, Context } from "@/lib/contracts";
import { uploadDocumentFile } from "@/lib/upload-client";
import { useApi, ApiError, describe } from "@/lib/client-api";
import { Modal } from "./modal";
import { ErrorAlert } from "@/components/ui/feedback";
import { formatDate } from "@/lib/format";

export function CarrierOnboarding({
  carrierId,
  context,
  onClose,
  onChanged,
  onAuthError,
  demo = false,
}: {
  carrierId: string;
  context: Context;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onAuthError: (e: unknown) => void;
  demo?: boolean;
}) {
  const api = useApi();
  const [data, setData] = useState<CarrierSetup | null>(null),
    [step, setStep] = useState("company"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [addingDriver, setAddingDriver] = useState(false),
    [invite, setInvite] = useState<{
      link: string;
      expires_at: string;
      name: string;
    } | null>(null),
    [copied, setCopied] = useState(false);
  const agreementUpload = useRef<{ signature: string; key: string } | null>(
    null,
  );
  // Upload the signed agreement as a versioned document, then return the
  // version that the dispatcher is verifying. Re-submitting identical bytes
  // reuses the current version instead of creating a duplicate.
  async function uploadAgreement(carrierId: string, file: File) {
    const signature = [file.name, file.size, file.lastModified].join("|");
    if (agreementUpload.current?.signature !== signature)
      agreementUpload.current = { signature, key: crypto.randomUUID() };
    try {
      return (
        await uploadDocumentFile(
          api,
          {
            carrier_id: carrierId,
            type: "dispatch_agreement",
            idempotency_key: agreementUpload.current.key,
          },
          file,
          { demo },
        )
      ).version_id;
    } catch (e) {
      if (
        !(e instanceof ApiError && e.message === "DUPLICATE_DOCUMENT_VERSION")
      )
        throw e;
      const docs = await api<CarrierDocuments>(
        "carriers/" + carrierId + "/documents",
      );
      const current = docs.slots.find(
        (s) => s.type === "dispatch_agreement",
      )?.current;
      if (!current) throw e;
      return current.id;
    }
  }
  const [removingDriver, setRemovingDriver] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null),
    pending = useRef<{
      signature: string;
      input: Record<string, unknown>;
    } | null>(null);
  const load = useCallback(async () => {
    const setup = await api<CarrierSetup>(
      "onboarding/carriers/" + (data?.carrier.id || carrierId),
    );
    setData(setup);
    return setup;
  }, [carrierId, data?.carrier.id, api]);
  useEffect(() => {
    if (carrierId === "new") return;
    let active = true;
    api<CarrierSetup>("onboarding/carriers/" + carrierId)
      .then((d) => {
        if (active) {
          setData(d);
          setStep(d.profile?.step === "agreement" ? "agreement" : "team");
        }
      })
      .catch((e) => {
        if (active) {
          if (e instanceof ApiError && e.status === 401) onAuthError(e);
          else setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [carrierId, api, onAuthError]);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      else setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  async function save(
    path: string,
    body: Record<string, unknown>,
    secret = false,
  ) {
    const signature = path + JSON.stringify(body);
    if (pending.current?.signature !== signature) {
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      pending.current = {
        signature,
        input: {
          ...body,
          key: crypto.randomUUID(),
          ...(secret ? { token } : {}),
        },
      };
    }
    const result = await api<{
      id: string;
      expires_at: string;
      pending_approval?: boolean;
    }>(path, pending.current.input);
    const token = pending.current.input.token;
    return { ...result, token };
  }
  async function invitePerson(
    path: string,
    body: Record<string, unknown>,
    name: string,
  ) {
    await act(async () => {
      const result = await save(path, body, true);
      setInvite({
        link:
          window.location.origin +
          (demo ? "/demo/join#" : "/join#") +
          result.token,
        expires_at: result.expires_at,
        name,
      });
      pending.current = null;
      setCopied(false);
      setAddingDriver(false);
      setNotice(
        "Invitation created. An email is queued to the recipient when email delivery is configured; you can also copy the private link below.",
      );
      await load();
      await onChanged();
    });
  }
  const company = data?.profile;
  const [dates] = useState(() => ({
    today: new Date().toISOString().slice(0, 10),
    nextYear: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
  }));
  const { today, nextYear } = dates;
  return (
    <Modal
      label="Carrier setup"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <section className="inspector onboardingPanel" aria-busy={busy}>
        <div className="inspectorHeader">
          <p className="eyebrow">CARRIER ONBOARDING</p>
          <button
            className="iconButton"
            aria-label="Close carrier setup"
            disabled={busy}
            onClick={onClose}
          >
            <XIcon size={20} />
          </button>
        </div>
        <div className="setupMark">
          <BuildingsIcon size={25} />
        </div>
        <p className="setupStepCount">
          {step === "done"
            ? "Setup complete"
            : `Step ${step === "company" ? 1 : step === "agreement" ? 2 : 3} of 3`}
        </p>
        <h2 ref={heading} tabIndex={-1}>
          {step === "company"
            ? "Start with the essentials."
            : step === "agreement"
              ? "Confirm dispatch authority."
              : step === "done"
                ? "Your carrier is ready."
                : "Bring your team in."}
        </h2>
        <p className="setupIntro">
          {step === "company"
            ? "A company name and one contact are enough to get started."
            : step === "agreement"
              ? "A dispatcher must review a signed agreement before loads can be booked."
              : step === "done"
                ? "Your setup is saved. Drivers can join through their own private links."
                : "Invite the carrier contact and drivers. Each person sets their own password."}
        </p>
        {step !== "done" && (
          <div
            className="setupProgress"
            role="progressbar"
            aria-label="Carrier setup progress"
            aria-valuemin={1}
            aria-valuemax={3}
            aria-valuenow={
              step === "company" ? 1 : step === "agreement" ? 2 : 3
            }
          >
            {["company", "agreement", "team"].map((s, i) => (
              <span key={s} className={s === step ? "active" : ""}>
                {i + 1}.{" "}
                {s === "company"
                  ? "Company"
                  : s === "agreement"
                    ? "Agreement"
                    : "Team"}
              </span>
            ))}
          </div>
        )}
        {error && (
          <ErrorAlert>
            <span>
              {error === "VERSION_CONFLICT"
                ? "This carrier was updated. Reload the saved details before trying again."
                : describe(error)}
            </span>
            {data && (
              <button
                className="textButton"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await load();
                  })
                }
              >
                Reload saved details
              </button>
            )}
            {!data && carrierId !== "new" && (
              <button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await load();
                  })
                }
              >
                Retry
              </button>
            )}
          </ErrorAlert>
        )}
        {notice && (
          <p role="status" className="inlineNotice">
            {notice}
          </p>
        )}
        {carrierId !== "new" && !data && !error ? (
          <p role="status" className="setupIntro">
            Opening saved setup…
          </p>
        ) : null}
        {step === "company" && (carrierId === "new" || data) && (
          <form
            key={data ? data.carrier.id + ":" + (company?.version ?? 0) : "new"}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              act(async () => {
                const body = {
                  name: String(f.get("name")),
                  contact_name: String(f.get("contact_name")),
                  contact_email: String(f.get("contact_email")),
                  phone: String(f.get("phone") || ""),
                  usdot: String(f.get("usdot") || ""),
                  mc_number: String(f.get("mc_number") || ""),
                  ...(data
                    ? { change_reason: String(f.get("change_reason") || "") }
                    : {}),
                };
                if (!data) {
                  const created = await save("onboarding/carriers", {
                    ...body,
                    organization_id: String(f.get("organization")),
                  });
                  const setup = await api<CarrierSetup>(
                    "onboarding/carriers/" + created.id,
                  );
                  setData(setup);
                  setStep("agreement");
                  setNotice("Company details saved.");
                  await onChanged();
                } else {
                  const saved = await save(
                    "onboarding/carriers/" + data.carrier.id + "/company",
                    { ...body, version: company?.version ?? 0 },
                  );
                  setData(
                    await api<CarrierSetup>(
                      "onboarding/carriers/" + data.carrier.id,
                    ),
                  );
                  setStep(data.agreement?.current ? "team" : "agreement");
                  // After setup, a new name, email, phone or USDOT number waits
                  // for a second person (ADR 0070).
                  setNotice(
                    saved.pending_approval
                      ? "Saved. The new name, email, phone, USDOT or MC number counts once a second person approves it in the carrier's files."
                      : "Company details saved.",
                  );
                  await onChanged();
                }
              });
            }}
          >
            <fieldset disabled={busy} className="setupFields">
              <legend className="srOnly">Company details</legend>
              {!data && (context.organizations?.length ?? 0) > 1 && (
                <label>
                  Workspace
                  <select name="organization">
                    {context.organizations?.map((o) => (
                      <option value={o.id} key={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!data && (context.organizations?.length ?? 0) === 1 && (
                <input
                  type="hidden"
                  name="organization"
                  value={context.organizations![0].id}
                />
              )}
              <label>
                Company name
                <input
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={data?.carrier.name || ""}
                  autoComplete="organization"
                />
              </label>
              <label>
                Contact name
                <input
                  name="contact_name"
                  required
                  maxLength={120}
                  defaultValue={company?.contact_name || ""}
                  autoComplete="name"
                />
              </label>
              <label>
                Contact email
                <input
                  name="contact_email"
                  type="email"
                  required
                  maxLength={254}
                  defaultValue={company?.contact_email || ""}
                  autoComplete="email"
                />
              </label>
              <details className="setupOptional">
                <summary>Additional company details · optional</summary>
                <label>
                  Phone
                  <input
                    name="phone"
                    type="tel"
                    maxLength={40}
                    defaultValue={company?.phone || ""}
                  />
                </label>
                <label>
                  USDOT number
                  <input
                    name="usdot"
                    inputMode="numeric"
                    pattern="[0-9]{1,8}|^$"
                    maxLength={8}
                    defaultValue={company?.usdot || ""}
                  />
                  <small>
                    Used to look up the carrier&apos;s public registration.
                  </small>
                </label>
                <label>
                  MC number
                  <input
                    name="mc_number"
                    inputMode="numeric"
                    pattern="[0-9]{1,8}|^$"
                    maxLength={8}
                    defaultValue={company?.mc_number || ""}
                  />
                  <small>
                    Checked against the USDOT number, to catch a sold or
                    hijacked registration.
                  </small>
                </label>
              </details>
              {company?.step === "complete" && (
                <label>
                  Why a name, email, phone, USDOT or MC number is changing
                  <small>
                    {" "}
                    (needed if you change one of them; a second person approves
                    it)
                  </small>
                  <input name="change_reason" maxLength={500} />
                </label>
              )}
              <button className="primary full">
                {busy ? "Saving…" : "Save and continue"}
                <ArrowRightIcon size={16} />
              </button>
            </fieldset>
          </form>
        )}
        {step === "agreement" && data && (
          <>
            <p className="setupCarrierName">{data.carrier.name}</p>
            {data.can_verify ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  act(async () => {
                    const file = f.get("agreement_file");
                    if (!(file instanceof File) || !file.size)
                      throw new ApiError(400, "FILE_REQUIRED");
                    const versionId = await uploadAgreement(
                      data.carrier.id,
                      file,
                    );
                    await save(
                      "onboarding/carriers/" + data.carrier.id + "/agreement",
                      {
                        document_version_id: versionId,
                        reference: String(f.get("reference")),
                        effective_date: String(f.get("effective")),
                        through_date: String(f.get("through")),
                        confirmed: f.get("confirmed") === "on",
                      },
                    );
                    setData(
                      await api<CarrierSetup>(
                        "onboarding/carriers/" + data.carrier.id,
                      ),
                    );
                    agreementUpload.current = null;
                    setStep("team");
                    setNotice("Agreement file stored and review saved.");
                  });
                }}
              >
                <fieldset disabled={busy} className="setupFields">
                  <legend className="srOnly">Dispatch agreement</legend>
                  <label>
                    Signed agreement file
                    <input
                      name="agreement_file"
                      type="file"
                      accept="application/pdf,image/png,image/jpeg"
                      required
                    />
                    <small>
                      PDF, PNG or JPEG up to 25 MB. The file is stored as an
                      immutable version and linked to this review.
                    </small>
                  </label>
                  <label>
                    Agreement reference
                    <input name="reference" required maxLength={300} />
                    <small>
                      Contract number or title, for example “Dispatch services
                      agreement 2026”.
                    </small>
                  </label>
                  <div className="formGrid">
                    <label>
                      Valid from
                      <input
                        type="date"
                        name="effective"
                        required
                        defaultValue={today}
                      />
                    </label>
                    <label>
                      Valid through
                      <input
                        type="date"
                        name="through"
                        required
                        defaultValue={nextYear}
                      />
                    </label>
                  </div>
                  <small>Dates are inclusive and recorded in UTC.</small>
                  <label className="setupCheckbox">
                    <input name="confirmed" type="checkbox" required />
                    <span>
                      I reviewed the signed agreement and confirmed dispatch
                      authorization for this carrier.
                    </span>
                  </label>
                  <button className="primary full">
                    {busy ? "Saving…" : "Save agreement and continue"}
                    <ArrowRightIcon size={16} />
                  </button>
                </fieldset>
              </form>
            ) : (
              <p className="setupCallout">
                Your dispatcher needs to confirm the signed agreement. You can
                prepare the team in the meantime.
              </p>
            )}
            <button
              className="textButton"
              disabled={busy}
              onClick={() => setStep("company")}
            >
              Back to company details
            </button>
            {!data.can_verify && (
              <button className="secondary" onClick={() => setStep("team")}>
                Continue to team
              </button>
            )}
          </>
        )}
        {step === "team" && data && (
          <>
            <div className="setupSummary">
              <strong>{data.carrier.name}</strong>
              <span
                className={
                  data.agreement?.current ? "setupReady" : "setupPending"
                }
              >
                {data.agreement?.current
                  ? "Agreement active"
                  : "Agreement review needed"}
              </span>
              {data.agreement && (
                <small className="setupAgreementFile">
                  {data.agreement.document
                    ? "File on record: " + data.agreement.document.filename
                    : "Reference only — no agreement file on record"}
                </small>
              )}
              <button
                className="textButton"
                disabled={busy}
                onClick={() => setStep("company")}
              >
                Edit company
              </button>
              {data.can_verify && (
                <button
                  className="textButton"
                  disabled={busy}
                  onClick={() => setStep("agreement")}
                >
                  {data.agreement?.current
                    ? "Record another agreement"
                    : "Review agreement"}
                </button>
              )}
            </div>
            {data.can_verify && (
              <div className="setupSection">
                <h3>Carrier contact</h3>
                {company ? (
                  <>
                    <p>
                      {company.contact_name} · {company.contact_email}
                    </p>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        invitePerson(
                          "onboarding/carriers/" +
                            data.carrier.id +
                            "/manager-invite",
                          {},
                          company.contact_name,
                        )
                      }
                    >
                      Create carrier invitation
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setStep("company")}
                  >
                    Add a contact to invite a carrier manager
                  </button>
                )}
              </div>
            )}
            <div className="setupSection">
              <div className="setupSectionHeading">
                <h3>Drivers</h3>
                {!addingDriver && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setAddingDriver(true);
                      setInvite(null);
                    }}
                  >
                    <PlusIcon size={14} />
                    Add driver
                  </button>
                )}
              </div>
              {!data.drivers.length && !addingDriver && (
                <p className="setupIntro">
                  Add a driver when you are ready. They will only see loads
                  assigned to them.
                </p>
              )}
              {data.drivers.map((d) => (
                <article className="setupDriver" key={d.id}>
                  <div>
                    <strong>{d.name}</strong>
                    <small>{d.email || "Existing driver"}</small>
                  </div>
                  <span>
                    {d.onboarding_status === "ready"
                      ? "Ready"
                      : "Waiting to join"}
                  </span>
                  {d.onboarding_status === "pending" && (
                    <button
                      className="textButton"
                      disabled={busy}
                      onClick={() =>
                        invitePerson(
                          "onboarding/carriers/" +
                            data.carrier.id +
                            "/drivers/" +
                            d.id +
                            "/invite",
                          {},
                          d.name,
                        )
                      }
                    >
                      New invite link
                    </button>
                  )}
                  {removingDriver === d.id ? (
                    <form
                      className="opsForm setupRemove"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const reason = String(
                          new FormData(e.currentTarget).get("reason"),
                        );
                        act(async () => {
                          await api(
                            "carriers/" + data.carrier.id + "/team/remove",
                            { driver_id: d.id, reason },
                          );
                          setRemovingDriver(null);
                          setNotice(d.name + " was removed from the roster.");
                          await load();
                        });
                      }}
                    >
                      <label>
                        Reason for removing {d.name}
                        <input name="reason" required maxLength={500} />
                      </label>
                      <div className="opsActions">
                        <button className="primary" disabled={busy}>
                          Remove driver
                        </button>
                        <button
                          type="button"
                          className="textButton"
                          onClick={() => setRemovingDriver(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      className="textButton"
                      disabled={busy}
                      aria-label={"Remove " + d.name}
                      onClick={() => setRemovingDriver(d.id)}
                    >
                      Remove
                    </button>
                  )}
                </article>
              ))}
              {addingDriver && (
                <form
                  aria-label="Add driver"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    invitePerson(
                      "onboarding/carriers/" + data.carrier.id + "/drivers",
                      {
                        name: String(f.get("name")),
                        email: String(f.get("email")),
                      },
                      String(f.get("name")),
                    );
                  }}
                >
                  <fieldset disabled={busy} className="setupFields">
                    <legend className="srOnly">Driver details</legend>
                    <label>
                      Driver name
                      <input name="name" required maxLength={120} autoFocus />
                    </label>
                    <label>
                      Driver email
                      <input
                        name="email"
                        type="email"
                        required
                        maxLength={254}
                      />
                    </label>
                    <div className="setupActions">
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => setAddingDriver(false)}
                      >
                        Cancel
                      </button>
                      <button className="primary">
                        Create driver invitation
                      </button>
                    </div>
                  </fieldset>
                </form>
              )}
            </div>
            {invite && (
              <div
                className="setupInvite"
                role="region"
                aria-label="Private invitation"
              >
                <strong>Invite {invite.name}</strong>
                <p>
                  {demo
                    ? "Demo link: open it in this browser to try joining."
                    : "Share this link privately."}{" "}
                  It expires {formatDate(invite.expires_at)} and works once. No
                  email has been sent.
                </p>
                <label>
                  <span className="srOnly">Invitation link</span>
                  <input
                    readOnly
                    value={invite.link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </label>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(invite.link);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                      setNotice(
                        "Select the invitation link and copy it manually.",
                      );
                    }
                  }}
                >
                  <CopyIcon size={15} />
                  {copied ? "Copied" : "Copy invitation link"}
                </button>
              </div>
            )}
            <div className="setupActions">
              <button className="secondary" disabled={busy} onClick={onClose}>
                Save and close
              </button>
              <button
                className="primary"
                disabled={busy || !data.agreement?.current}
                onClick={() =>
                  act(async () => {
                    await api(
                      "onboarding/carriers/" + data.carrier.id + "/complete",
                      {},
                    );
                    setStep("done");
                    await onChanged();
                  })
                }
              >
                Finish setup
                <ArrowRightIcon size={15} />
              </button>
            </div>
            {!data.agreement?.current && (
              <p className="setupIntro">
                Booking stays unavailable until a dispatcher records a current
                agreement.
              </p>
            )}
          </>
        )}
        {step === "done" && (
          <div className="setupComplete">
            <CheckCircleIcon size={45} />
            <p>
              You can return to this carrier to add drivers or update contact
              details.
            </p>
            <button className="primary full" onClick={onClose}>
              Open workspace
            </button>
            <button className="textButton" onClick={() => setStep("team")}>
              Back to team
            </button>
          </div>
        )}
        <p className="setupSaveHint">
          Details save when you continue. Close and resume any saved step.
        </p>
      </section>
    </Modal>
  );
}
