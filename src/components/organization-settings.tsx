"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AiSettings } from "@/components/ai-settings";
import { StaffInvites } from "./staff-invites";
import { ApiError, useApi } from "@/lib/client-api";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import type { Context } from "@/lib/contracts";
import { ErrorAlert } from "@/components/ui/feedback";

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

const tabs = [
  { id: "profile", label: "Profile" },
  { id: "people", label: "People" },
  { id: "invites", label: "Invitations" },
  { id: "ai", label: "AI" },
] as const;
type Tab = (typeof tabs)[number]["id"];
const pageSize = 25;

/**
 * Organization settings in four tabs so no section pushes the others out of
 * view. People is one searchable list across carriers, not a card per carrier.
 */
export function OrganizationSettings({
  context,
  onAuthError,
  onChanged,
  query = "",
}: {
  context: Context;
  onAuthError: (e: unknown) => void;
  onChanged: () => Promise<void>;
  /** Search text from the sidebar; filters People. */
  query?: string;
}) {
  const api = useApi();
  const orgs = (context.organizations || []).filter((o) => o.role);
  const [orgId, setOrgId] = useState(orgs[0]?.id || ""),
    [data, setData] = useState<Organization | null>(null),
    [tab, setTab] = useState<Tab>("profile"),
    [carrierFilter, setCarrierFilter] = useState(""),
    [shown, setShown] = useState(pageSize),
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
  const carriers = useMemo<[string, string][]>(
    () =>
      data
        ? [...new Map(data.team.map((p) => [p.carrier_id, p.carrier_name]))]
        : [],
    [data],
  );
  const needle = query.trim().toLowerCase();
  const people = useMemo(
    () =>
      (data?.team ?? []).filter(
        (p) =>
          (!carrierFilter || p.carrier_id === carrierFilter) &&
          (!needle ||
            [p.name, p.email, p.carrier_name, roleLabels[p.role] ?? p.role]
              .join(" ")
              .toLowerCase()
              .includes(needle)),
      ),
    [data, carrierFilter, needle],
  );
  const visible = people.slice(0, shown);

  return (
    <section className="orgPage" aria-label="Organization settings">
      <div className="orgIntro">
        <p>Company profile, administrators, people and AI settings.</p>
        {orgs.length > 1 && (
          <label className="orgPicker">
            <span className="srOnly">Organization</span>
            <select
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setData(null);
                setCarrierFilter("");
              }}
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!orgs.length && (
        <p className="helpText">
          You are not an administrator of a dispatch organization.
        </p>
      )}
      <ErrorAlert error={error} />
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice}
      </p>
      {orgs.length > 0 && !data && !error && (
        <p className="helpText" role="status">
          Loading organization…
        </p>
      )}
      {data && (
        <>
          <Tabs
            label="Organization"
            idPrefix="org"
            items={tabs.map((t) =>
              t.id === "people" ? { ...t, count: data.team.length } : t,
            )}
            value={tab}
            onChange={setTab}
          />
          <TabPanel idPrefix="org" value={tab} className="orgPanel">
            {tab === "profile" && (
              <div className="orgGrid">
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
                  <div className="formGrid">
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
                      <input
                        name="phone"
                        maxLength={40}
                        defaultValue={data.phone}
                      />
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
                  <div className="opsActions">
                    <button className="primary" disabled={busy}>
                      Save profile
                    </button>
                  </div>
                </form>
                <article className="opsCard">
                  <h3>Administrators</h3>
                  {data.admins.map((a) => (
                    <div className="teamRow" key={a.id}>
                      <span className="opsTeamName">
                        {a.name}
                        <small>
                          {roleLabels[a.role]} · {a.email}
                        </small>
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
                    New organizations are created by your Relay operator (see
                    the README). Invite teammates in the Invitations tab.
                  </small>
                </article>
              </div>
            )}

            {tab === "people" && (
              <article className="opsCard">
                <div className="orgToolbar">
                  <h3>People with carrier access</h3>
                  <label className="orgPicker">
                    <span className="srOnly">Carrier</span>
                    <select
                      value={carrierFilter}
                      onChange={(e) => {
                        setCarrierFilter(e.target.value);
                        setShown(pageSize);
                        setRemoving(null);
                      }}
                    >
                      <option value="">All carriers ({carriers.length})</option>
                      {carriers.map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="opsMeta" role="status">
                  {people.length
                    ? `Showing ${visible.length} of ${people.length}`
                    : needle || carrierFilter
                      ? "No one matches."
                      : "No one has carrier access yet."}
                </p>
                <ul className="orgPeople">
                  {visible.map((p) => (
                    <li key={p.user_id + p.carrier_id}>
                      <div className="teamRow">
                        <span className="opsTeamName">
                          {p.name}
                          <small>{p.email}</small>
                        </span>
                        <span className="orgMeta">
                          {roleLabels[p.role] ?? p.role} · {p.carrier_name}
                        </span>
                        <SecurityPills
                          verified={p.email_verified}
                          mfa={p.mfa_enabled}
                        />
                        <button
                          className="textButton"
                          disabled={busy}
                          aria-label={`Remove ${p.name} from ${p.carrier_name}`}
                          onClick={() => setRemoving(p)}
                        >
                          Remove
                        </button>
                      </div>
                      {removing?.user_id === p.user_id &&
                        removing.carrier_id === p.carrier_id && (
                          <form
                            className="opsForm orgRemove"
                            aria-label={`Remove ${p.name} from ${p.carrier_name}`}
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const reason = String(
                                new FormData(e.currentTarget).get("reason"),
                              );
                              const ok = await act(async () => {
                                await api(
                                  "carriers/" + p.carrier_id + "/team/remove",
                                  p.driver_id
                                    ? { driver_id: p.driver_id, reason }
                                    : { user_id: p.user_id, reason },
                                );
                                await onChanged();
                                return `${p.name} no longer has access to ${p.carrier_name}.`;
                              });
                              if (ok) setRemoving(null);
                            }}
                          >
                            <p className="opsMeta">
                              Remove {p.name}&apos;s access to {p.carrier_name}?
                              Their history stays. Open exceptions they own
                              return to the queue
                              {p.driver_id
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
                    </li>
                  ))}
                </ul>
                {people.length > shown && (
                  <button
                    className="secondary"
                    onClick={() => setShown((n) => n + pageSize)}
                  >
                    Show {Math.min(pageSize, people.length - shown)} more
                  </button>
                )}
              </article>
            )}

            {tab === "invites" && (
              <StaffInvites
                organizationId={data.id}
                isOwner={data.role === "owner"}
                carriers={carriers}
                onAuthError={onAuthError}
              />
            )}

            {tab === "ai" && (
              <AiSettings organizationId={data.id} onAuthError={onAuthError} />
            )}
          </TabPanel>
        </>
      )}
    </section>
  );
}
