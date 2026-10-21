"use client";
import { useCallback, useEffect, useState, useRef } from "react";
type Load = {
  id: string;
  reference: string;
  carrier_id: string;
  carrier_name: string;
  stage: string;
  amount_minor: string;
  pickup: string;
  delivery: string;
  version: number;
  stops?: {
    kind: string;
    address: string;
    window_start: string;
    timezone: string;
  }[];
  events?: { id: string; type: string; created_at: string }[];
  assignment?: { name: string } | null;
};
type Context = {
  user: { name: string };
  carriers: { id: string; name: string; role: string }[];
  drivers: { id: string; name: string; carrier_id: string }[];
};
function explainError(code: string) {
  return (
    (
      {
        VERSION_CONFLICT:
          "This load changed. Close and reopen its details, then try again.",
        INVALID_CREDENTIALS: "Email or password is incorrect.",
        SERVICE_UNAVAILABLE:
          "The service is unavailable. Check your connection and retry.",
        CARRIER_AUTHORIZATION_REQUIRED:
          "This carrier needs a verified, effective dispatch agreement before booking.",
        DUPLICATE_REFERENCE:
          "This carrier already has a load with that reference.",
        ASSIGN_DRIVER_FIRST: "Assign an authorized driver before dispatching.",
        VALIDATION_ERROR:
          "Check the load details: pickup must precede delivery, the time zone must be valid, and the rate must be whole cents.",
        TRY_AGAIN_LATER:
          "Too many sign-in attempts. Please try again in a minute.",
        NOT_FOUND: "This record is unavailable or outside your carrier access.",
        AUTH_REQUIRED: "Please sign in to continue.",
        SESSION_EXPIRED: "Your session expired. Please sign in again.",
      } as Record<string, string>
    )[code] || code
  );
}
async function api(path: string, body?: unknown, key?: string) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: body
      ? {
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        }
      : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
function Modal({
  children,
  label,
  onClose,
}: {
  children: React.ReactNode;
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} className="overlay" aria-label={label} onCancel={onClose}>
      {children}
    </dialog>
  );
}
export default function Workspace() {
  const [context, setContext] = useState<Context | null>(null),
    [ready, setReady] = useState(false),
    [loads, setLoads] = useState<Load[]>([]),
    [selected, setSelected] = useState<Load | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [q, setQ] = useState(""),
    [carrier, setCarrier] = useState(""),
    [status, setStatus] = useState(""),
    [creating, setCreating] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [offline, setOffline] = useState(false);
  const refresh = useCallback(async () => {
    const d = await api(
      "loads?" +
        new URLSearchParams({
          ...(q ? { q } : {}),
          ...(carrier ? { carrier_id: carrier } : {}),
          ...(status ? { status } : {}),
        }),
    );
    setLoads(d.loads);
    setCursor(d.nextCursor);
  }, [q, carrier, status]);
  useEffect(() => {
    api("me")
      .then(setContext)
      .catch((e) => {
        if (e.message !== "AUTH_REQUIRED" && e.message !== "SESSION_EXPIRED")
          setError(e.message);
      })
      .finally(() => setReady(true));
    const off = () => setOffline(!navigator.onLine);
    window.addEventListener("online", off);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", off);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    fetch(
      "/api/loads?" +
        new URLSearchParams({
          ...(q ? { q } : {}),
          ...(carrier ? { carrier_id: carrier } : {}),
          ...(status ? { status } : {}),
        }),
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        return data;
      })
      .then((d) => {
        setLoads(d.loads);
        setCursor(d.nextCursor);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [context, q, carrier, status]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    await act(async () => setSelected(await api("loads/" + id)));
  }
  if (!ready)
    return (
      <main className="loading" role="status">
        Opening dispatch workspace…
      </main>
    );
  if (!context)
    return (
      <main className="login">
        <div className="brand">
          ▰ relay<span>DISPATCH OPERATIONS</span>
        </div>
        <section>
          <p className="eyebrow">YOUR OPERATIONS, IN SYNC</p>
          <h1>Welcome back.</h1>
          <p>Sign in to your carrier workspace.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              act(async () => {
                await api("login", {
                  email: f.get("email"),
                  password: f.get("password"),
                });
                setContext(await api("me"));
              });
            }}
          >
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button disabled={busy}>Sign in →</button>
          </form>
          {error && (
            <p role="alert" className="error">
              {explainError(error)}
            </p>
          )}
          <small>
            Local QA uses fictional data.{" "}
            <a href="/demo.html">Explore the original demo ↗</a>
          </small>
        </section>
      </main>
    );
  const canWrite = context.carriers.some((c) => c.role !== "driver");
  const selectedRole = context.carriers.find(
    (c) => c.id === selected?.carrier_id,
  )?.role;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          ▰ relay<span>DISPATCH OPERATIONS</span>
        </div>
        <p className="navlabel">WORKSPACE</p>
        <button
          className="nav active"
          onClick={() => {
            setStatus("");
            setSelected(null);
          }}
        >
          ▦ &nbsp; Dispatch board
        </button>
        <a className="nav" href="/demo.html">
          ↗ &nbsp; Original demo
        </a>
        <div className="sidebarBottom">
          <span className="avatar">{context.user.name[0]}</span>
          <strong>
            {context.user.name}
            <small>Carrier workspace</small>
          </strong>
          <button
            aria-label="Sign out"
            onClick={() =>
              act(async () => {
                await api("logout", {});
                setContext(null);
                setSelected(null);
              })
            }
          >
            ↪
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <p className="eyebrow">OPERATIONS / DISPATCH</p>
            <h1>
              Dispatch board<span className="live">● QA environment</span>
            </h1>
            <p>Every load. Every milestone. One clear view.</p>
          </div>
          {canWrite && (
            <button onClick={() => setCreating(true)}>＋ Create load</button>
          )}
        </header>
        <div className="qa">
          FICTIONAL QA WORKSPACE{" "}
          <span>Local data · no live tracking or external integrations</span>
        </div>
        {offline && (
          <p role="alert" className="error">
            Offline — displayed information may be stale. Reconnect and refresh.
          </p>
        )}
        {error && (
          <div role="alert" className="error">
            {explainError(error)}{" "}
            <button onClick={() => act(refresh)}>Retry</button>
          </div>
        )}
        <section className="stats">
          <article>
            <span>VISIBLE LOADS</span>
            <strong>{loads.length}</strong>
            <small>Current queue page</small>
          </article>
          <article>
            <span>AWAITING DISPATCH</span>
            <strong>{loads.filter((l) => l.stage === "booked").length}</strong>
            <small>Ready for next action</small>
          </article>
          <article>
            <span>IN TRANSIT</span>
            <strong>
              {loads.filter((l) => l.stage === "picked-up").length}
            </strong>
            <small>Pickup recorded</small>
          </article>
          <article>
            <span>DELIVERED</span>
            <strong>
              {loads.filter((l) => l.stage === "delivered").length}
            </strong>
            <small>Documents tracked separately</small>
          </article>
        </section>
        <section className="board">
          <div className="boardTop">
            <h2>
              Load workspace <span>{loads.length}</span>
            </h2>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => act(refresh)}
            >
              ↻ Refresh
            </button>
          </div>
          <div className="filters">
            <label className="search">
              Search loads
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search reference…"
              />
            </label>
            <label>
              Carrier
              <select
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
              >
                <option value="">All authorized carriers</option>
                {context.carriers.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Milestone
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All milestones</option>
                {["booked", "dispatched", "picked-up", "delivered"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>LOAD / CARRIER</th>
                  <th>ROUTE</th>
                  <th>MILESTONE</th>
                  <th>AGREED RATE</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <button className="loadLink" onClick={() => open(l.id)}>
                        {l.reference}
                      </button>
                      <small>{l.carrier_name}</small>
                    </td>
                    <td>
                      {l.pickup}
                      <small>↓ &nbsp; {l.delivery}</small>
                    </td>
                    <td>
                      <span className={"badge " + l.stage}>
                        {l.stage.replace("-", " ")}
                      </span>
                    </td>
                    <td>
                      {new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                      }).format(Number(l.amount_minor) / 100)}
                    </td>
                    <td>
                      <button
                        className="secondary"
                        onClick={() => open(l.id)}
                        aria-label={"Open " + l.reference}
                      >
                        →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loads.length && (
            <div className="empty">
              <h3>No loads in this view</h3>
              <p>
                Try another filter or create a load for an authorized carrier.
              </p>
            </div>
          )}
          {cursor && (
            <button
              className="secondary"
              onClick={() =>
                act(async () => {
                  const d = await api(
                    "loads?" +
                      new URLSearchParams({
                        cursor,
                        ...(q ? { q } : {}),
                        ...(carrier ? { carrier_id: carrier } : {}),
                        ...(status ? { status } : {}),
                      }),
                  );
                  setLoads([...loads, ...d.loads]);
                  setCursor(d.nextCursor);
                })
              }
            >
              Load more
            </button>
          )}
        </section>
        <footer>
          RELAY WORKSPACE{" "}
          <span>
            Tracking, document uploads, and financial workflows are not
            connected in this foundation.
          </span>
        </footer>
      </main>
      {selected && (
        <Modal label="Load details" onClose={() => setSelected(null)}>
          <section className="inspector">
            <button
              autoFocus
              className="close secondary"
              onClick={() => setSelected(null)}
            >
              Close ✕
            </button>
            <p className="eyebrow">LOAD WORKSPACE</p>
            <h2>{selected.reference}</h2>
            <span className="badge">{selected.stage}</span>
            <h3>Route & appointments</h3>
            {selected.stops?.map((s, i) => (
              <article className="stop" key={i}>
                <small>{s.kind.toUpperCase()}</small>
                <strong>{s.address}</strong>
                <p>
                  {new Date(s.window_start).toLocaleString("en-US", {
                    timeZone: s.timezone,
                  })}{" "}
                  · {s.timezone}
                </p>
              </article>
            ))}
            <h3>Driver assignment</h3>
            <p>{selected.assignment?.name || "No driver assigned"}</p>
            {selectedRole !== "driver" && (
              <>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    act(async () => {
                      await api("loads/" + selected.id + "/assign", {
                        version: selected.version,
                        driverId: f.get("driver"),
                      });
                      setSelected(await api("loads/" + selected.id));
                      await refresh();
                    });
                  }}
                >
                  <label>
                    Authorized driver
                    <select name="driver" required>
                      <option value="">Choose driver</option>
                      {context.drivers
                        .filter((d) => d.carrier_id === selected.carrier_id)
                        .map((d) => (
                          <option value={d.id} key={d.id}>
                            {d.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button disabled={busy || selected.stage === "delivered"}>
                    Assign driver
                  </button>
                </form>
                {selected.stage !== "delivered" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const stage = [
                          "booked",
                          "dispatched",
                          "picked-up",
                          "delivered",
                        ][
                          [
                            "booked",
                            "dispatched",
                            "picked-up",
                            "delivered",
                          ].indexOf(selected.stage) + 1
                        ];
                        await api("loads/" + selected.id + "/milestones", {
                          version: selected.version,
                          stage,
                        });
                        setSelected(await api("loads/" + selected.id));
                        await refresh();
                      })
                    }
                  >
                    Record next milestone →
                  </button>
                )}
              </>
            )}
            <h3>Activity timeline</h3>
            {selected.events?.length ? (
              selected.events.map((e) => (
                <p className="event" key={e.id}>
                  {{
                    "load.created": "Load created",
                    "load.assign": "Driver assigned",
                    "load.milestones": "Milestone recorded",
                  }[e.type] || e.type}
                  <small>{new Date(e.created_at).toLocaleString()}</small>
                </p>
              ))
            ) : (
              <p>Imported QA fixture · no operational events yet.</p>
            )}
            {error && (
              <p role="alert" className="error">
                {explainError(error)}
              </p>
            )}
          </section>
        </Modal>
      )}
      {creating && (
        <Modal label="Create load" onClose={() => setCreating(false)}>
          <section className="inspector">
            <button
              autoFocus
              className="close secondary"
              onClick={() => setCreating(false)}
            >
              Close ✕
            </button>
            <p className="eyebrow">NEW BOOKED LOAD</p>
            <h2>Start with a clear route.</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const data = {
                  carrierId: f.get("carrier"),
                  reference: f.get("reference"),
                  source: f.get("source"),
                  amountMinor: Number(f.get("amount")),
                  stops: ["pickup", "delivery"].map((kind) => ({
                    kind,
                    address: f.get(kind),
                    timezone: f.get("timezone"),
                    windowStart: new Date(
                      String(f.get(kind + "Time")),
                    ).toISOString(),
                    windowEnd: new Date(
                      String(f.get(kind + "Time")),
                    ).toISOString(),
                  })),
                };
                act(async () => {
                  await api("loads", data, crypto.randomUUID());
                  setCreating(false);
                  await refresh();
                });
              }}
            >
              <label>
                Carrier
                <select name="carrier" required>
                  {context.carriers
                    .filter((c) => c.role !== "driver")
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Load reference
                <input name="reference" maxLength={100} required />
              </label>
              <label>
                Booking source / rate confirmation reference
                <input name="source" required />
              </label>
              <label>
                Agreed rate (USD cents)
                <input type="number" name="amount" min="0" step="1" required />
              </label>
              <label>
                IANA time zone
                <input
                  name="timezone"
                  defaultValue="America/Chicago"
                  required
                />
              </label>
              {["pickup", "delivery"].map((s) => (
                <fieldset key={s}>
                  <legend>{s}</legend>
                  <label>
                    Address
                    <input name={s} required />
                  </label>
                  <label>
                    Appointment (your browser time zone)
                    <input name={s + "Time"} type="datetime-local" required />
                  </label>
                </fieldset>
              ))}
              <button disabled={busy}>Create booked load</button>
            </form>
            {error && (
              <p role="alert" className="error">
                {explainError(error)}
              </p>
            )}
          </section>
        </Modal>
      )}
    </div>
  );
}
