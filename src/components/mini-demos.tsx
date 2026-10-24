"use client";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiContext, ApiError, describe } from "@/lib/client-api";
import { createDemoApi } from "@/lib/demo-api";
import { demoTemplates, fillFromLoad } from "@/lib/demo-documents";
import type { Context, Load } from "@/lib/contracts";
import { LoadCard } from "@/components/load-card";
import { LoadCheckIns } from "@/components/load-check-ins";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/entry";

/**
 * Small working pieces of the product for the public pages: show it instead of
 * describing it. Each one runs the real screens' components, and the demo's own
 * rules and error messages, against private fictional data that lives in memory
 * (never the demo's saved state, never a server).
 */
const nothing = () => undefined;

export function MiniFrame({
  title,
  hint,
  bare = false,
  children,
}: {
  title: string;
  /** What to try, in one line. */
  hint: string;
  /** The page already names it, so the frame shows only the hint. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className="miniFrame" aria-label={bare ? title : undefined}>
      <figcaption>
        {!bare && <strong>{title}</strong>}
        <span>{hint}</span>
      </figcaption>
      <div className="shell appShell miniShell">{children}</div>
    </figure>
  );
}

/** Said once per page, not under every interaction. */
export function MiniNote({ wide = false }: { wide?: boolean }) {
  return (
    <p className={"miniNote" + (wide ? " wide" : "")}>
      The interactions and pictures use fictional sample data in your browser.
      Nothing is sent.
    </p>
  );
}

/** A private fictional workspace: its context and loads, reloadable. */
function useWorld() {
  const [adapter] = useState(() => createDemoApi({ persist: false }));
  const [world, setWorld] = useState<{
    context: Context;
    loads: Load[];
  } | null>(null);
  const reload = useCallback(async () => {
    const [context, list] = await Promise.all([
      adapter.api<Context>("me"),
      adapter.api<{ loads: Load[] }>("loads"),
    ]);
    setWorld({ context, loads: list.loads });
  }, [adapter]);
  useEffect(() => {
    let live = true;
    // Fetch once on mount; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload().catch(() => live && setWorld(null));
    return () => {
      live = false;
    };
  }, [reload]);
  return { adapter, world, reload };
}

const byRef = (loads: Load[], ref: string) =>
  loads.find((l) => l.reference === ref);
const Loading = () => <p className="miniLoading">Loading the sample…</p>;

function Message({
  tone,
  children,
}: {
  tone: "good" | "bad";
  children: ReactNode;
}) {
  return (
    <p className={"miniMessage " + tone} role="status">
      {children}
    </p>
  );
}

/** Book and dispatch: the real rules refuse another carrier's driver. */
export function MiniAssign({ bare = false }: { bare?: boolean }) {
  const { adapter, world, reload } = useWorld();
  const [driver, setDriver] = useState("");
  const [result, setResult] = useState<{
    tone: "good" | "bad";
    text: string;
  } | null>(null);
  const id = useId();
  const load = world && byRef(world.loads, "RL-101");
  const drivers = useMemo(
    () =>
      world?.context.drivers.map((d) => ({
        ...d,
        carrier: world.context.carriers.find((c) => c.id === d.carrier_id)
          ?.name,
      })) ?? [],
    [world],
  );
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await reload();
      setResult({ tone: "good", text: done });
    } catch (e) {
      setResult({
        tone: "bad",
        text: describe(
          e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE",
        ),
      });
    }
  };
  return (
    <MiniFrame
      bare={bare}
      title="Book and dispatch"
      hint="Assign Morgan Reed, who drives for another carrier. Then Jordan Ellis."
    >
      {!world || !load ? (
        <Loading />
      ) : (
        <div className="miniStack">
          <LoadCard load={load} disabled={false} onOpen={nothing} />
          <form
            className="miniForm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!driver) return;
              void act(
                () =>
                  adapter.api(`loads/${load.id}/assign`, {
                    version: load.version,
                    driverId: driver,
                  }),
                "Driver assigned.",
              );
            }}
          >
            <label htmlFor={id}>Driver</label>
            <select
              id={id}
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
            >
              <option value="">Choose a driver</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.carrier}
                </option>
              ))}
            </select>
            <div className="miniActions">
              <button className="secondary" disabled={!driver}>
                Assign driver
              </button>
              <button
                type="button"
                className="primary"
                disabled={load.stage !== "booked"}
                onClick={() =>
                  void act(
                    () =>
                      adapter.api(`loads/${load.id}/milestones`, {
                        version: load.version,
                        stage: "dispatched",
                      }),
                    "Dispatched. The change is recorded with who made it.",
                  )
                }
              >
                Dispatch
              </button>
              <button
                type="button"
                className="textButton"
                onClick={() => {
                  adapter.reset();
                  setResult(null);
                  setDriver("");
                  void reload();
                }}
              >
                Start over
              </button>
            </div>
          </form>
          {result && <Message tone={result.tone}>{result.text}</Message>}
        </div>
      )}
    </MiniFrame>
  );
}

/** Follow and resolve: record a check-in and see where it came from. */
export function MiniCheckIn({ bare = false }: { bare?: boolean }) {
  const { adapter, world, reload } = useWorld();
  const [detail, setDetail] = useState<Load | null>(null);
  const loadId = world && byRef(world.loads, "RL-102")?.id;
  const refresh = useCallback(async () => {
    if (!loadId) return;
    let load = await adapter.api<Load>("loads/" + loadId);
    // Start with one report so the source and time are already on show.
    if (!load.check_ins?.length) {
      await adapter.api(`loads/${loadId}/check-ins`, {
        version: load.version,
        location: "Columbus, OH",
        note: "Loaded and rolling.",
        observed_at: new Date(Date.now() - 40 * 60000).toISOString(),
        idempotency_key: crypto.randomUUID(),
      });
      load = await adapter.api<Load>("loads/" + loadId);
    }
    setDetail(load);
  }, [adapter, loadId]);
  useEffect(() => {
    // Fetch once the sample load is known; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  return (
    <MiniFrame
      bare={bare}
      title="Follow and resolve"
      hint="Add a check-in. It keeps its source and the time it was observed."
    >
      {!world || !detail ? (
        <Loading />
      ) : (
        <ApiContext.Provider value={adapter.api}>
          <LoadCheckIns
            load={detail}
            busy={false}
            offline={false}
            role="dispatcher"
            onAmended={async () => {
              await refresh();
              await reload();
            }}
            onRecord={async (input) => {
              try {
                await adapter.api(`loads/${detail.id}/check-ins`, input);
                await refresh();
                return "saved";
              } catch {
                return "retry";
              }
            }}
          />
        </ApiContext.Provider>
      )}
    </MiniFrame>
  );
}

type Step = { label: string; tone: "neutral" | "warn" | "good" };
function Track({
  title,
  who,
  amount,
  steps,
  done,
  onAdvance,
}: {
  title: string;
  who: string;
  amount: string;
  steps: Step[];
  done: number;
  onAdvance: () => void;
}) {
  const current = steps[done];
  return (
    <div className="miniTrack">
      <div>
        <strong>{title}</strong>
        <small>{who}</small>
      </div>
      <span className="miniAmount">{amount}</span>
      <StatusBadge tone={current.tone}>{current.label}</StatusBadge>
      <button
        className="secondary"
        disabled={done === steps.length - 1}
        onClick={onAdvance}
      >
        {done === steps.length - 1
          ? "Done"
          : `Mark ${steps[done + 1].label.toLowerCase()}`}
      </button>
    </div>
  );
}

/** Bill, separately: two records that never move together. */
export function MiniBilling({ bare = false }: { bare?: boolean }) {
  const freight = 245000,
    feeBasisPoints = 800;
  const fee = Math.round((freight * feeBasisPoints) / 10000);
  const [packet, setPacket] = useState(0);
  const [invoice, setInvoice] = useState(0);
  const packetSteps: Step[] = [
    { label: "Draft", tone: "neutral" },
    { label: "Submitted to broker", tone: "warn" },
    { label: "Paid by broker", tone: "good" },
  ];
  const invoiceSteps: Step[] = [
    { label: "Draft", tone: "neutral" },
    { label: "Issued", tone: "warn" },
    { label: "Paid by carrier", tone: "good" },
  ];
  return (
    <MiniFrame
      bare={bare}
      title="Bill, separately"
      hint="Move one. The other stays where it is."
    >
      <div className="miniStack">
        <Track
          title="Carrier freight packet"
          who="Carrier bills the broker"
          amount={formatMoney(String(freight))}
          steps={packetSteps}
          done={packet}
          onAdvance={() => setPacket((n) => n + 1)}
        />
        <Track
          title="Your dispatch invoice"
          who="You bill the carrier, 8% fee"
          amount={formatMoney(String(fee))}
          steps={invoiceSteps}
          done={invoice}
          onAdvance={() => setInvoice((n) => n + 1)}
        />
        <p className="miniCaption" role="status">
          Packet: {packetSteps[packet].label}. Invoice:{" "}
          {invoiceSteps[invoice].label}.
        </p>
      </div>
    </MiniFrame>
  );
}

/** Drafts: a template filled from a load; what is missing stays visible. */
export function MiniDraft({ bare = false }: { bare?: boolean }) {
  const { world } = useWorld();
  const [ref, setRef] = useState("RL-101");
  const [reviewed, setReviewed] = useState(false);
  const id = useId();
  const template = useMemo(() => demoTemplates()[0], []);
  const load = world && byRef(world.loads, ref);
  const filled = useMemo(
    () => (load ? fillFromLoad(load, template.body) : null),
    [load, template],
  );
  return (
    <MiniFrame
      bare={bare}
      title="Draft from a template"
      hint="Switch loads. A value Relay does not have is flagged, never guessed."
    >
      {!world || !filled ? (
        <Loading />
      ) : (
        <div className="miniStack">
          <div className="miniForm">
            <label htmlFor={id}>Fill “{template.name}” from</label>
            <select
              id={id}
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                setReviewed(false);
              }}
            >
              {world.loads.slice(0, 3).map((l) => (
                <option key={l.id} value={l.reference}>
                  {l.reference} · {l.carrier_name}
                </option>
              ))}
            </select>
          </div>
          <pre className="draftBody miniDraft" aria-label="Draft text">
            {filled.text
              .split(/(\[missing: [a-z_.]+\])/g)
              .map((part, i) =>
                part.startsWith("[missing:") ? (
                  <mark key={i}>{part}</mark>
                ) : (
                  part
                ),
              )}
          </pre>
          <div className="miniActions">
            <StatusBadge tone={reviewed ? "good" : "warn"}>
              {reviewed ? "Reviewed" : "Needs review"}
            </StatusBadge>
            <button
              className="secondary"
              disabled={reviewed}
              onClick={() => setReviewed(true)}
            >
              Mark as reviewed
            </button>
          </div>
          <p className="miniCaption" role="status">
            {filled.missing.length
              ? `Missing: ${filled.missing.join(", ")}. Fill it in before using the text.`
              : reviewed
                ? "A person read it. Relay does not send it anywhere."
                : "Nothing is missing. A person still reads it first."}
          </p>
        </div>
      )}
    </MiniFrame>
  );
}

/** AI is off until an owner turns it on. */
export function MiniAiSwitch({ bare = false }: { bare?: boolean }) {
  const [on, setOn] = useState(false);
  return (
    <MiniFrame
      bare={bare}
      title="AI is off until you turn it on"
      hint="Owners and admins decide. Flip it."
    >
      <div className="miniStack">
        <div className="miniTrack">
          <div>
            <strong>AI reading and assistant</strong>
            <small>{on ? "On for this organization" : "Off by default"}</small>
          </div>
          <button
            role="switch"
            aria-checked={on}
            className={"miniSwitch" + (on ? " on" : "")}
            onClick={() => setOn(!on)}
          >
            <span className="srOnly">AI reading and assistant</span>
          </button>
        </div>
        <p className="miniCaption" role="status">
          {on
            ? "Usage is billed to your own account and stops at the monthly limit you set."
            : "Nothing is read or written by AI. Documents and loads are entered by people."}
        </p>
      </div>
    </MiniFrame>
  );
}
