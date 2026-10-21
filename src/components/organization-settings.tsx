"use client";
import { useCallback, useEffect, useState } from "react";
import { UsersIcon } from "@phosphor-icons/react";
import { AiSettings } from "@/components/ai-settings";
import { StaffInvites } from "./staff-invites";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { Context } from "@/lib/contracts";

type Person = {
  user_id: string;
  name: string;
  email: string;
  role: string;
  driver_id: string | null;
  email_verified: boolean;
  mfa_enabled: boolean;
  carrier_id: string;
  carrier_name: string;
};
type Organization = {
  id: string;
  name: string;
  legal_name: string;
  billing_email: string;
  phone: string;
  address: string;
  timezone: string;
  version: number;
  role: string;
  admins: {
    id: string;
    name: string;
    email: string;
    role: string;
    email_verified: boolean;
    mfa_enabled: boolean;
  }[];
  team: Person[];
};
const zones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];
const roleLabels: Record<string, string> = {
  dispatcher: "Dispatcher",
  "carrier-manager": "Carrier manager",
  driver: "Driver",
  owner: "Owner",
  admin: "Admin",
};

function SecurityPills({ verified, mfa }: { verified: boolean; mfa: boolean }) {
  return (
    <span className="teamPills">
      <span className={"opsPill " + (verified ? "good" : "warn")}>
        {verified ? "Email verified" : "Email unverified"}
      </span>
      <span className={"opsPill " + (mfa ? "good" : "")}>
        {mfa ? "2-step on" : "2-step off"}
      </span>
    </span>
  );
}

export function OrganizationSettings({
  context,
  onAuthError,
  onChanged,
}: {
  context: Context;
  onAuthError: (e: unknown) => void;
  onChanged: () => Promise<void>;
}) {
  const api = useApi();
  const orgs = (context.organizations || []).filter((o) => o.role);
  const [orgId, setOrgId] = useState(orgs[0]?.id || ""),
    [data, setData] = useState<Organization | null>(null),
    [removing, setRemoving] = useState<Person | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      setData(await api<Organization>("organizations/" + orgId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    }
  }, [api, orgId, onAuthError]);
  useEffect(() => {
    // Fetch per selected organization; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      await load();
      setNotice(message);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const carriers = data
    ? [...new Map(data.team.map((p) => [p.carrier_id, p.carrier_name]))]
    : [];
  return (
    <section className="carrierDirectory" aria-label="Organization settings">
      <div className="directoryIntro">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h2>Organization</h2>
          <p>
            Company profile, administrators and who can access each carrier.
          </p>
        </div>
        {orgs.length > 1 && (
          <div className="directoryControls opsFilters">
            <label>
              <span className="srOnly">Organization</span>
              <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {!orgs.length && (
        <p className="helpText">
          You are not an administrator of a dispatch organization.
        </p>
      )}
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
        </div>
      )}
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice}
      </p>
      {data && (
        <div className="billingColumns">
          <form
            key={data.version}
            className="opsCard opsForm"
            aria-label="Organization profile"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api("organizations/" + data.id + "/profile", {
                  version: data.version,
                  name: String(f.get("name")),
                  legal_name: String(f.get("legal_name")),
                  billing_email: String(f.get("billing_email")),
                  phone: String(f.get("phone")),
                  address: String(f.get("address")),
                  timezone: String(f.get("timezone")),
                });
                await onChanged();
                return "Organization profile saved.";
              });
            }}
          >
            <h3>Company profile</h3>
            <label>
              Display name
              <input
                name="name"
                required
                maxLength={160}
                defaultValue={data.name}
              />
            </label>
            <label>
              Legal name
              <input
                name="legal_name"
                maxLength={200}
                defaultValue={data.legal_name}
              />
            </label>
            <div className="formGrid">
              <label>
                Billing email
                <input
                  name="billing_email"
                  type="email"
                  maxLength={254}
                  defaultValue={data.billing_email}
                />
              </label>
              <label>
                Phone
                <input name="phone" maxLength={40} defaultValue={data.phone} />
              </label>
            </div>
            <label>
              Address
              <textarea
                name="address"
                rows={2}
                maxLength={500}
                defaultValue={data.address}
              />
            </label>
            <label>
              Operating time zone
              <select name="timezone" defaultValue={data.timezone}>
                {[...new Set([data.timezone, ...zones])].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy}>
              Save profile
            </button>
          </form>
          <div className="opsList">
            <article className="opsCard">
              <h3>Administrators</h3>
              {data.admins.map((a) => (
                <div className="opsCardHeading teamRow" key={a.id}>
                  <span className="opsTeamName">
                    {a.name} · {roleLabels[a.role]}
                    <small>{a.email}</small>
                  </span>
                  <SecurityPills
                    verified={a.email_verified}
                    mfa={a.mfa_enabled}
                  />
                  {data.role === "owner" && a.role !== "owner" && (
                    <button
                      className="textButton"
                      disabled={busy}
                      aria-label={`Remove administrator ${a.name}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${a.name} as an administrator? Their carrier access is unchanged.`,
                          )
                        )
                          void act(async () => {
                            await api(
                              "organizations/" + data.id + "/admins/remove",
                              { user_id: a.id, reason: "Removed by owner" },
                            );
                            return `${a.name} is no longer an administrator.`;
                          });
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <small className="opsMeta">
                New organizations are created by your Relay operator (see the
                README). Invite teammates below.
              </small>
            </article>
            <AiSettings organizationId={data.id} onAuthError={onAuthError} />
            <StaffInvites
              organizationId={data.id}
              isOwner={data.role === "owner"}
              carriers={carriers}
              onAuthError={onAuthError}
            />
            {carriers.map(([carrierId, carrierName]) => (
              <article className="opsCard" key={carrierId}>
                <div className="opsCardHeading">
                  <UsersIcon size={16} aria-hidden="true" />
                  <h3>{carrierName}</h3>
                </div>
                {data.team
                  .filter((p) => p.carrier_id === carrierId)
                  .map((p) => (
                    <div className="opsCardHeading teamRow" key={p.user_id}>
                      <span className="opsTeamName">
                        {p.name} · {roleLabels[p.role]}
                        <small>{p.email}</small>
                      </span>
                      <SecurityPills
                        verified={p.email_verified}
                        mfa={p.mfa_enabled}
                      />
                      <button
                        className="textButton"
                        disabled={busy}
                        aria-label={`Remove ${p.name} from ${carrierName}`}
                        onClick={() => setRemoving(p)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                {removing?.carrier_id === carrierId && (
                  <form
                    className="opsForm"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const reason = String(
                        new FormData(e.currentTarget).get("reason"),
                      );
                      const person = removing;
                      const ok = await act(async () => {
                        await api(
                          "carriers/" + person.carrier_id + "/team/remove",
                          person.driver_id
                            ? { driver_id: person.driver_id, reason }
                            : { user_id: person.user_id, reason },
                        );
                        await onChanged();
                        return `${person.name} no longer has access to ${person.carrier_name}.`;
                      });
                      if (ok) setRemoving(null);
                    }}
                  >
                    <p className="opsMeta">
                      Remove {removing.name}&apos;s access to {carrierName}?
                      Their history stays. Open exceptions they own return to
                      the queue
                      {removing.driver_id
                        ? ", and they leave the driver roster"
                        : ""}
                      .
                    </p>
                    <label>
                      Reason
                      <input name="reason" required maxLength={500} />
                    </label>
                    <div className="opsActions">
                      <button className="primary" disabled={busy}>
                        Remove access
                      </button>
                      <button
                        type="button"
                        className="textButton"
                        onClick={() => setRemoving(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
