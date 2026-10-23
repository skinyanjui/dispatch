"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarBlankIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { Sheet } from "@/components/modal";
import { Board } from "@/components/board";
import { ToggleGroup } from "@/components/ui/toggle-group";
import {
  activityKinds,
  activityLabels,
  followUpText,
  prospectSources,
  prospectStages,
  sourceLabels,
  stageLabels,
  type FollowUp,
  type Prospect,
  type ProspectDetail,
  type ProspectList,
  type ProspectStage,
} from "@/lib/prospect-types";

const icon = { size: 15, "aria-hidden": true } as const;
const followLabels: Record<FollowUp, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "Next 7 days",
};
const when = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Card({
  prospect,
  today,
  onOpen,
}: {
  prospect: Prospect;
  today: string;
  onOpen: (id: string) => void;
}) {
  const follow = prospect.next_follow_up_on;
  const text = followUpText(follow, today);
  const overdue = follow !== null && follow < today;
  const trucks =
    prospect.truck_count === null
      ? ""
      : `${prospect.truck_count} ${prospect.truck_count === 1 ? "truck" : "trucks"}`;
  // The same card anatomy as a load: name and size, who, then small facts.
  return (
    <button
      className="loadCard lc prospectCard"
      onClick={() => onOpen(prospect.id)}
      aria-label={[
        prospect.company,
        prospect.contact_name,
        text,
        prospect.owner ? `Owner ${prospect.owner.name}` : "No owner",
      ]
        .filter(Boolean)
        .join(". ")}
    >
      <span className="lcHead">
        <strong className="lcRef" title={prospect.company}>
          {prospect.company}
        </strong>
        {trucks && <span className="lcAmount">{trucks}</span>}
      </span>
      {prospect.contact_name && (
        <span className="lcSub">{prospect.contact_name}</span>
      )}
      <span className="lcFacts">
        {text && (
          <span className={"lcFact" + (overdue ? " warn" : "")}>
            <CalendarBlankIcon size={12} aria-hidden="true" />
            {text}
          </span>
        )}
        <span className="lcFact">
          <UserIcon size={12} aria-hidden="true" />
          {prospect.owner?.name ?? "No owner"}
        </span>
        <span className="lcFact">{sourceLabels[prospect.source]}</span>
      </span>
    </button>
  );
}

function ProspectForm({
  prospect,
  list,
  busy,
  onSave,
  onCancel,
}: {
  prospect: Prospect | null;
  list: ProspectList;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
}) {
  // One retry identity per unchanged submission.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const org = prospect?.organization_id ?? list.organizations[0]?.id;
  const team = list.team.filter((m) => m.organization_id === org);
  return (
    <form
      className="opsForm"
      aria-label={prospect ? "Prospect details" : "Add prospect"}
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const trucks = String(f.get("truck_count")).trim();
        const body: Record<string, unknown> = {
          company: String(f.get("company")).trim(),
          contact_name: String(f.get("contact_name")).trim(),
          email: String(f.get("email")).trim(),
          phone: String(f.get("phone")).trim(),
          usdot: String(f.get("usdot")).trim(),
          truck_count: trucks === "" ? null : Number(trucks),
          source: String(f.get("source")),
          owner_id: String(f.get("owner_id")) || null,
          next_follow_up_on: String(f.get("next_follow_up_on")) || null,
          notes: String(f.get("notes")).trim(),
        };
        if (!prospect) {
          if (list.organizations.length > 1)
            body.organization_id = String(f.get("organization_id"));
          const signature = JSON.stringify(body);
          if (attempt.current?.signature !== signature)
            attempt.current = { signature, key: crypto.randomUUID() };
          body.idempotency_key = attempt.current.key;
        }
        await onSave(body);
      }}
    >
      <div className="formGrid">
        <label>
          Company
          <input
            name="company"
            required
            maxLength={160}
            defaultValue={prospect?.company}
            autoFocus={!prospect}
          />
        </label>
        <label>
          Contact name
          <input
            name="contact_name"
            maxLength={160}
            defaultValue={prospect?.contact_name}
          />
        </label>
      </div>
      <div className="formGrid">
        <label>
          Phone
          <input
            name="phone"
            type="tel"
            maxLength={40}
            defaultValue={prospect?.phone}
          />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            maxLength={254}
            defaultValue={prospect?.email}
          />
        </label>
      </div>
      <div className="formGrid">
        <label>
          USDOT <small>(optional)</small>
          <input
            name="usdot"
            inputMode="numeric"
            pattern="\d{1,8}"
            maxLength={8}
            defaultValue={prospect?.usdot}
          />
        </label>
        <label>
          Trucks <small>(optional)</small>
          <input
            name="truck_count"
            type="number"
            min={0}
            max={100000}
            step={1}
            defaultValue={prospect?.truck_count ?? ""}
          />
        </label>
      </div>
      <div className="formGrid">
        <label>
          Source
          <select name="source" defaultValue={prospect?.source ?? "other"}>
            {prospectSources.map((s) => (
              <option key={s} value={s}>
                {sourceLabels[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner
          <select name="owner_id" defaultValue={prospect?.owner?.id ?? ""}>
            <option value="">No owner</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="formGrid">
        <label>
          Next follow-up <small>(optional)</small>
          <input
            name="next_follow_up_on"
            type="date"
            defaultValue={prospect?.next_follow_up_on ?? ""}
          />
        </label>
        {!prospect && list.organizations.length > 1 && (
          <label>
            Organization
            <select name="organization_id">
              {list.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label>
        Notes <small>(optional)</small>
        <textarea
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={prospect?.notes}
        />
      </label>
      <div className="opsActions">
        <button className="primary" disabled={busy}>
          {prospect ? "Save details" : "Add prospect"}
        </button>
        {onCancel && (
          <button type="button" className="textButton" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Detail({
  id,
  list,
  offline,
  onClose,
  onChanged,
  onAuthError,
  onOpenCarriers,
  startLosing = false,
}: {
  id: string;
  list: ProspectList;
  offline: boolean;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
  onAuthError: (e: unknown) => void;
  onOpenCarriers?: () => void;
  /** Opened by dropping the card on Lost: ask why straight away. */
  startLosing?: boolean;
}) {
  const api = useApi();
  const [detail, setDetail] = useState<ProspectDetail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [losing, setLosing] = useState(startLosing);
  const activityKey = useRef<{ signature: string; key: string } | null>(null);
  const reload = useCallback(
    () =>
      api<ProspectDetail>("prospects/" + id)
        .then((d) => {
          setDetail(d);
          setError("");
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) onAuthError(e);
          setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
        }),
    [api, id, onAuthError],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  async function act(fn: () => Promise<string>, refresh = true) {
    setBusy(true);
    setError("");
    try {
      const message = await fn();
      if (refresh) await reload();
      await onChanged(message);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const p = detail?.prospect;
  return (
    <Sheet label="Prospect" eyebrow="Prospect" onClose={onClose}>
      <div className="inspectorBody">
        {error && (
          <div className="alert error" role="alert">
            {describe(error)}
            {!p && (
              <button className="secondary" onClick={() => void reload()}>
                Retry
              </button>
            )}
          </div>
        )}
        {!p && !error && (
          <p className="helpText" role="status">
            Loading…
          </p>
        )}
        {p && (
          <>
            <h2>{p.company}</h2>
            <div className="formGrid">
              <label>
                Stage
                <select
                  value={losing ? "lost" : p.stage}
                  disabled={busy || offline || !!p.carrier_id}
                  onChange={(e) => {
                    const stage = e.target.value as ProspectStage;
                    if (stage === "lost") return setLosing(true);
                    setLosing(false);
                    void act(async () => {
                      await api(`prospects/${p.id}/stage`, {
                        stage,
                        version: p.version,
                      });
                      return `Moved to ${stageLabels[stage]}.`;
                    });
                  }}
                >
                  {prospectStages.map((s) => (
                    <option key={s} value={s}>
                      {stageLabels[s]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="helpText prospectMeta">
                {p.stage === "lost" && p.lost_reason
                  ? `Lost: ${p.lost_reason}`
                  : p.carrier_id
                    ? "Became a carrier."
                    : `In ${stageLabels[p.stage]} since ${when(p.stage_changed_at)}`}
              </p>
            </div>
            {losing && (
              <form
                className="opsForm"
                aria-label="Why was this prospect lost"
                onSubmit={(e) => {
                  e.preventDefault();
                  const reason = String(
                    new FormData(e.currentTarget).get("reason"),
                  ).trim();
                  void act(async () => {
                    await api(`prospects/${p.id}/stage`, {
                      stage: "lost",
                      lost_reason: reason,
                      version: p.version,
                    });
                    setLosing(false);
                    return "Marked as lost.";
                  });
                }}
              >
                <label>
                  Why was it lost?
                  <input name="reason" required maxLength={300} autoFocus />
                </label>
                <div className="opsActions">
                  <button className="primary" disabled={busy}>
                    Mark as lost
                  </button>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => setLosing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <ProspectForm
              key={p.version}
              prospect={p}
              list={list}
              busy={busy || offline}
              onSave={async (body) => {
                await act(async () => {
                  await api(`prospects/${p.id}`, {
                    ...body,
                    version: p.version,
                  });
                  return "Prospect saved.";
                });
              }}
            />
            <h3>Log activity</h3>
            <form
              className="opsForm"
              aria-label="Log activity"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                const next = String(f.get("next_follow_up_on"));
                const body: Record<string, unknown> = {
                  kind: String(f.get("kind")),
                  body: String(f.get("body")).trim(),
                  ...(next ? { next_follow_up_on: next } : {}),
                };
                const signature = JSON.stringify(body);
                if (activityKey.current?.signature !== signature)
                  activityKey.current = { signature, key: crypto.randomUUID() };
                body.idempotency_key = activityKey.current.key;
                void act(async () => {
                  await api(`prospects/${p.id}/activities`, body);
                  activityKey.current = null;
                  form.reset();
                  return "Activity logged.";
                });
              }}
            >
              <div className="formGrid">
                <label>
                  Type
                  <select name="kind">
                    {activityKinds.map((k) => (
                      <option key={k} value={k}>
                        {activityLabels[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Next follow-up <small>(optional)</small>
                  <input name="next_follow_up_on" type="date" />
                </label>
              </div>
              <label>
                What happened?
                <textarea name="body" rows={2} required maxLength={2000} />
              </label>
              <div className="opsActions">
                <button className="secondary" disabled={busy || offline}>
                  Log activity
                </button>
              </div>
            </form>
            <ol className="prospectTimeline" aria-label="Activity">
              {detail.activities.map((a) => (
                <li key={a.id}>
                  <span>
                    <strong>{activityLabels[a.kind]}</strong>
                    {a.body && ` · ${a.body}`}
                  </span>
                  <small>
                    {a.actor_name} · {when(a.created_at)}
                  </small>
                </li>
              ))}
              {!detail.activities.length && (
                <li className="helpText">No activity yet.</li>
              )}
            </ol>
            <div className="opsActions prospectFooter">
              {p.carrier_id ? (
                onOpenCarriers && (
                  <button className="secondary" onClick={onOpenCarriers}>
                    Open carriers
                  </button>
                )
              ) : (
                <button
                  className="secondary"
                  disabled={busy || offline || p.stage === "lost"}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Start carrier setup for ${p.company}? This creates the carrier record only. Loads still need a verified dispatch agreement.`,
                      )
                    )
                      return;
                    void act(async () => {
                      await api(`prospects/${p.id}/convert`, {
                        version: p.version,
                      });
                      return `${p.company} is now a carrier in setup.`;
                    });
                  }}
                >
                  Start carrier setup
                </button>
              )}
              <button
                className="textButton"
                disabled={busy || offline}
                onClick={() => {
                  if (!window.confirm(`Archive ${p.company}?`)) return;
                  void act(async () => {
                    await api(`prospects/${p.id}/archive`, {
                      version: p.version,
                    });
                    onClose();
                    return `${p.company} archived.`;
                  }, false);
                }}
              >
                Archive
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

export function Prospects({
  offline,
  onAuthError,
  onOpenCarriers,
  query,
}: {
  offline: boolean;
  onAuthError: (e: unknown) => void;
  onOpenCarriers?: () => void;
  /** Search text from the page header; without it the page has its own box. */
  query?: string;
}) {
  const api = useApi();
  const [ownQ, setQ] = useState(""),
    [owner, setOwner] = useState(""),
    [follow, setFollow] = useState<"" | FollowUp>(""),
    [list, setList] = useState<ProspectList | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [losingId, setLosingId] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false);
  const q = query ?? ownQ;
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(owner ? { owner } : {}),
        ...(follow ? { follow_up: follow } : {}),
      });
      const result = await api<ProspectList>("prospects?" + params);
      if (id === request.current) setList(result);
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [api, q, owner, follow, onAuthError]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);
  const total = list
    ? prospectStages.reduce((sum, s) => sum + list.counts[s], 0)
    : 0;
  const filtered = !!(q || owner || follow);
  /** Dragging a card to another stage; Lost first asks why. */
  async function moveTo(id: string, stage: ProspectStage) {
    const p = list?.prospects.find((x) => x.id === id);
    if (!p || p.stage === stage || p.carrier_id) return;
    if (stage === "lost") {
      setLosingId(id);
      setSelected(id);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`prospects/${id}/stage`, { stage, version: p.version });
      setNotice(`${p.company} moved to ${stageLabels[stage]}.`);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="carrierDirectory" aria-label="Prospects">
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Prospects</h2>
          <p className="dirNote">
            Starting carrier setup creates the carrier record only.
          </p>
        </div>
        <button
          className="primary"
          disabled={offline || !list}
          onClick={() => setAdding(true)}
        >
          <PlusIcon {...icon} weight="bold" />
          Add prospect
        </button>
      </div>
      <div className="contactFilters">
        <label className="directorySearch" hidden={query !== undefined}>
          <MagnifyingGlassIcon size={16} aria-hidden="true" />
          <span className="srOnly">Search prospects</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Company, contact, email, phone or USDOT…"
            maxLength={100}
          />
        </label>
        <label>
          <span className="srOnly">Owner</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Everyone</option>
            <option value="me">Mine</option>
            {list?.team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <ToggleGroup
          label="Follow-ups"
          items={(Object.keys(followLabels) as FollowUp[]).map((key) => ({
            id: key,
            label: followLabels[key],
            count: list?.follow_ups[key] ?? 0,
            tone: key === "overdue" ? ("late" as const) : undefined,
          }))}
          hideEmpty
          allowNone
          value={follow || null}
          onChange={(key) => setFollow(key ?? "")}
        />
      </div>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice ||
          (loading
            ? "Loading prospects"
            : `${list?.prospects.length ?? 0} prospects shown`)}
      </p>
      {list && !total && !loading && !error ? (
        <div className="directoryEmpty">
          <MagnifyingGlassIcon size={36} weight="light" aria-hidden="true" />
          <h3>No prospects yet</h3>
          <p>
            Add the carriers you are talking to and track each conversation.
          </p>
        </div>
      ) : (
        <Board
          label="Prospect board"
          noun="prospects"
          className="prospectBoard"
          lanes={prospectStages.map((stage) => {
            const items =
              list?.prospects.filter((p) => p.stage === stage) ?? [];
            return {
              id: stage,
              label: stageLabels[stage],
              items,
              count: filtered ? items.length : (list?.counts[stage] ?? 0),
            };
          })}
          laneClass={(stage) => "prospect-" + stage}
          itemKey={(p) => p.id}
          renderCard={(p) => (
            <Card
              prospect={p}
              today={list!.today}
              onOpen={(id) => {
                setLosingId(null);
                setSelected(id);
              }}
            />
          )}
          empty={loading ? "Loading…" : "None here"}
          // A prospect that became a carrier keeps that outcome.
          canDrag={(p) => !busy && !offline && !p.carrier_id}
          onMove={(id, stage) => void moveTo(id, stage as ProspectStage)}
        />
      )}
      {list?.truncated && (
        <small>Showing the first 500. Search or filter to narrow down.</small>
      )}
      {adding && list && (
        <Sheet
          label="Add prospect"
          eyebrow="New prospect"
          onClose={() => setAdding(false)}
        >
          <div className="inspectorBody">
            {error && (
              <div className="alert error" role="alert">
                {describe(error)}
              </div>
            )}
            <ProspectForm
              prospect={null}
              list={list}
              busy={busy || offline}
              onCancel={() => setAdding(false)}
              onSave={async (body) => {
                setBusy(true);
                setError("");
                try {
                  await api("prospects", body);
                  setAdding(false);
                  setNotice("Prospect added.");
                  await load();
                } catch (e) {
                  if (e instanceof ApiError && e.status === 401) onAuthError(e);
                  setError(
                    e instanceof Error ? e.message : "SERVICE_UNAVAILABLE",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
        </Sheet>
      )}
      {selected && list && (
        <Detail
          key={selected + (losingId === selected ? ":lost" : "")}
          startLosing={losingId === selected}
          id={selected}
          list={list}
          offline={offline}
          onClose={() => {
            setSelected(null);
            setLosingId(null);
          }}
          onAuthError={onAuthError}
          onOpenCarriers={onOpenCarriers}
          onChanged={async (message) => {
            setNotice(message);
            await load();
          }}
        />
      )}
    </section>
  );
}
