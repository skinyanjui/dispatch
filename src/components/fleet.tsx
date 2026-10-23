"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { PlusIcon } from "@phosphor-icons/react";
import { Sheet } from "@/components/modal";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { Context } from "@/lib/contracts";

type Driver = {
  id: string;
  name: string;
  status: "pending" | "ready";
  phone: string;
  email: string | null;
  active_loads: number;
};
type Vehicle = {
  id: string;
  label: string;
  kind: string;
  plate: string;
  vin: string;
  status: "active" | "retired";
  version: number;
  active_loads: number;
};
type Fleet = {
  carrier: { id: string; name: string };
  drivers: Driver[];
  vehicles: Vehicle[];
};
export const vehicleKindLabels: Record<string, string> = {
  tractor: "Tractor",
  straight_truck: "Straight truck",
  box_truck: "Box truck",
  cargo_van: "Cargo van",
  sprinter_van: "Sprinter van",
  trailer: "Trailer",
  other: "Other",
};

/** Drivers and vehicles of one carrier, with vehicles added, edited and
 *  retired here (ADR 0048). Drivers are invited and removed in carrier setup. */
export function FleetPage({
  context,
  query = "",
  onClearQuery,
  initialCarrier = "",
  onManageDrivers,
  onAuthError,
  offline,
}: {
  context: Context;
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
  /** The carrier chosen in the sidebar, when there is one. */
  initialCarrier?: string;
  /** Opens that carrier's setup, where drivers are invited and removed. */
  onManageDrivers: (carrierId: string) => void;
  onAuthError: (e: unknown) => void;
  offline: boolean;
}) {
  const api = useApi();
  const carriers = context.carriers.filter((c) => c.role !== "driver");
  const [carrierId, setCarrierId] = useState(
    carriers.some((c) => c.id === initialCarrier)
      ? initialCarrier
      : (carriers[0]?.id ?? ""),
  );
  const [data, setData] = useState<Fleet | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(""),
    [showRetired, setShowRetired] = useState(false),
    [form, setForm] = useState<Vehicle | "new" | null>(null),
    [retiring, setRetiring] = useState<Vehicle | null>(null);
  const request = useRef(0);
  const load = useCallback(async () => {
    if (!carrierId) return;
    const mine = ++request.current;
    setLoading(true);
    setError("");
    try {
      const next = await api<Fleet>("fleet?carrier_id=" + carrierId);
      if (mine === request.current) setData(next);
    } catch (e) {
      if (mine !== request.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, [api, carrierId, onAuthError]);
  useEffect(() => {
    // Fetch per selected carrier; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const needle = query.trim().toLowerCase();
  const match = (...parts: (string | null)[]) =>
    !needle || parts.some((p) => p?.toLowerCase().includes(needle));
  const drivers = (data?.drivers ?? []).filter((d) =>
    match(d.name, d.email, d.phone),
  );
  const retiredCount = (data?.vehicles ?? []).filter(
    (v) => v.status === "retired",
  ).length;
  const vehicles = (data?.vehicles ?? []).filter(
    (v) =>
      (showRetired || v.status === "active") &&
      match(v.label, v.plate, v.vin, vehicleKindLabels[v.kind]),
  );
  async function setStatus(v: Vehicle, status: "active" | "retired") {
    setError("");
    setNotice("");
    try {
      await api(`fleet/vehicles/${v.id}/status`, {
        status,
        version: v.version,
        key: crypto.randomUUID(),
      });
      setNotice(
        status === "retired"
          ? `${v.label} retired. It can’t be chosen for new loads.`
          : `${v.label} is back in service.`,
      );
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      void load();
    }
  }
  const all = data?.vehicles ?? [];
  const inService = all.filter((v) => v.status === "active");
  const tiles: [string, number][] = [
    ["Vehicles in service", inService.length],
    ["On active loads", inService.filter((v) => v.active_loads > 0).length],
    [
      "Drivers active",
      (data?.drivers ?? []).filter((d) => d.status === "ready").length,
    ],
    [
      "Invites pending",
      (data?.drivers ?? []).filter((d) => d.status === "pending").length,
    ],
  ];
  return (
    <section className="fleetPage" aria-label="Fleet">
      <h2 className="srOnly">Fleet</h2>
      <div className="fleetBar">
        {carriers.length > 1 ? (
          <label>
            <span className="srOnly">Carrier</span>
            <select
              value={carrierId}
              onChange={(e) => {
                setData(null);
                setCarrierId(e.target.value);
              }}
            >
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <strong className="fleetCarrier">{data?.carrier.name}</strong>
        )}
        <button
          type="button"
          className="primary"
          disabled={offline || !data}
          onClick={() => setForm("new")}
        >
          <PlusIcon size={14} weight="bold" aria-hidden="true" /> Add vehicle
        </button>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <p
        className={notice ? "inlineNotice" : "srOnly"}
        role="status"
        aria-live="polite"
      >
        {notice ||
          (loading
            ? "Loading the fleet"
            : data
              ? `${drivers.length} drivers and ${vehicles.length} vehicles shown`
              : "")}
      </p>
      {loading && !data && !error && (
        <div className="fleetSkeleton" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
      {data && (
        <>
          <StatTiles label="Fleet summary">
            {tiles.map(([label, n]) => (
              <StatTile key={label} label={label} value={n} />
            ))}
          </StatTiles>
          <section className="fleetPanel" aria-labelledby="fleet-vehicles">
            <header>
              <h3 id="fleet-vehicles">
                Vehicles <span className="countBadge">{vehicles.length}</span>
              </h3>
              {retiredCount > 0 && (
                <label className="filterCheck">
                  <input
                    type="checkbox"
                    checked={showRetired}
                    onChange={(e) => setShowRetired(e.target.checked)}
                  />
                  <span>Show retired ({retiredCount})</span>
                </label>
              )}
            </header>
            {vehicles.length ? (
              <div
                className="tableScroll"
                role="region"
                aria-label="Vehicles"
                tabIndex={0}
              >
                <table className="reportTable fleetTable">
                  <caption className="srOnly">Vehicles</caption>
                  <thead>
                    <tr>
                      <th scope="col">Unit</th>
                      <th scope="col">Type</th>
                      <th scope="col">Plate</th>
                      <th scope="col">VIN</th>
                      <th scope="col">Status</th>
                      <th scope="col">Active loads</th>
                      <th scope="col">
                        <span className="srOnly">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vehicles.map((v) => (
                      <tr
                        key={v.id}
                        className={
                          v.status === "retired" ? "retired" : undefined
                        }
                      >
                        <th scope="row" data-label="Unit">
                          {v.label}
                        </th>
                        <td data-label="Type">
                          {vehicleKindLabels[v.kind] ?? v.kind}
                        </td>
                        <td data-label="Plate">{v.plate || "—"}</td>
                        <td data-label="VIN">
                          {v.vin ? <code>{v.vin}</code> : "—"}
                        </td>
                        <td data-label="Status">
                          <span
                            className={
                              "opsPill " + (v.status === "active" ? "good" : "")
                            }
                          >
                            {v.status === "active" ? "In service" : "Retired"}
                          </span>
                        </td>
                        <td data-label="Active loads">{v.active_loads}</td>
                        <td data-label="Actions">
                          <div className="fleetActions">
                            <button
                              type="button"
                              className="secondary"
                              disabled={offline}
                              onClick={() => setForm(v)}
                            >
                              Edit<span className="srOnly"> {v.label}</span>
                            </button>
                            {v.status === "active" ? (
                              <button
                                type="button"
                                className="secondary"
                                disabled={offline}
                                onClick={() => setRetiring(v)}
                              >
                                Retire
                                <span className="srOnly"> {v.label}</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="secondary"
                                disabled={offline}
                                onClick={() => void setStatus(v, "active")}
                              >
                                Reactivate
                                <span className="srOnly"> {v.label}</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="fleetEmpty">
                <h4>{needle ? "No vehicles match" : "No vehicles yet"}</h4>
                <p>
                  {needle
                    ? "Try another unit, plate or VIN."
                    : "Add the tractors, trucks, vans and trailers this carrier runs, then choose one when you assign a driver."}
                </p>
                {needle ? (
                  <button className="secondary" onClick={onClearQuery}>
                    Clear search
                  </button>
                ) : (
                  <button className="primary" onClick={() => setForm("new")}>
                    Add vehicle
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="fleetPanel" aria-labelledby="fleet-drivers">
            <header>
              <h3 id="fleet-drivers">
                Drivers <span className="countBadge">{drivers.length}</span>
              </h3>
              <button
                type="button"
                className="secondary"
                onClick={() => onManageDrivers(carrierId)}
              >
                Invite or remove drivers
              </button>
            </header>
            {drivers.length ? (
              <div
                className="tableScroll"
                role="region"
                aria-label="Drivers"
                tabIndex={0}
              >
                <table className="reportTable fleetTable">
                  <caption className="srOnly">Drivers</caption>
                  <thead>
                    <tr>
                      <th scope="col">Driver</th>
                      <th scope="col">Status</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Email</th>
                      <th scope="col">Active loads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drivers.map((d) => (
                      <tr key={d.id}>
                        <th scope="row" data-label="Driver">
                          {d.name}
                        </th>
                        <td data-label="Status">
                          <span
                            className={
                              "opsPill " +
                              (d.status === "ready" ? "good" : "warn")
                            }
                          >
                            {d.status === "ready" ? "Active" : "Invite pending"}
                          </span>
                        </td>
                        <td data-label="Phone">{d.phone || "—"}</td>
                        <td data-label="Email">{d.email || "—"}</td>
                        <td data-label="Active loads">{d.active_loads}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="fleetEmpty">
                <h4>{needle ? "No drivers match" : "No drivers yet"}</h4>
                <p>
                  {needle
                    ? "Try another name."
                    : "Invite drivers in carrier setup so loads can be assigned."}
                </p>
              </div>
            )}
          </section>
        </>
      )}
      {form && (
        <VehicleForm
          carrierId={carrierId}
          vehicle={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onAuthError={onAuthError}
          onSaved={async (message) => {
            setForm(null);
            setNotice(message);
            await load();
          }}
        />
      )}
      {retiring && (
        <Sheet
          label="Retire vehicle"
          eyebrow="Fleet"
          onClose={() => setRetiring(null)}
        >
          <div className="inspectorBody">
            <h2>Retire {retiring.label}?</h2>
            <p className="setupIntro">
              A retired vehicle can’t be chosen for new loads.
              {retiring.active_loads
                ? ` It stays on its ${retiring.active_loads} active ${retiring.active_loads === 1 ? "load" : "loads"}.`
                : " Past loads keep it."}{" "}
              You can bring it back at any time.
            </p>
            <div className="formActions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const v = retiring;
                  setRetiring(null);
                  void setStatus(v, "retired");
                }}
              >
                Retire vehicle
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setRetiring(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </section>
  );
}

function VehicleForm({
  carrierId,
  vehicle,
  onClose,
  onSaved,
  onAuthError,
}: {
  carrierId: string;
  vehicle: Vehicle | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // One key per form, so a retried save after a lost response is not a second
  // vehicle; a changed form gets a fresh one.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = {
      label: String(form.get("label") ?? "").trim(),
      kind: String(form.get("kind")),
      plate: String(form.get("plate") ?? "").trim(),
      vin: String(form.get("vin") ?? "").trim(),
    };
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      if (vehicle)
        await api("fleet/vehicles/" + vehicle.id, {
          ...body,
          version: vehicle.version,
          key: attempt.current.key,
        });
      else
        await api("fleet/vehicles", {
          carrier_id: carrierId,
          ...body,
          key: attempt.current.key,
        });
      await onSaved(
        vehicle ? `${body.label} saved.` : `${body.label} added to the fleet.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      setError(err instanceof Error ? err.message : "SERVICE_UNAVAILABLE");
      setBusy(false);
    }
  }
  return (
    <Sheet
      label={vehicle ? "Edit vehicle" : "Add vehicle"}
      eyebrow="Fleet"
      onClose={() => !busy && onClose()}
    >
      <form className="inspectorBody" onSubmit={submit} aria-label="Vehicle">
        <h2>{vehicle ? `Edit ${vehicle.label}` : "Add a vehicle"}</h2>
        <label>
          Unit name
          <input
            name="label"
            required
            maxLength={60}
            defaultValue={vehicle?.label}
            placeholder="e.g. Unit 12"
            autoFocus
          />
        </label>
        <label>
          Type
          <select name="kind" defaultValue={vehicle?.kind ?? "tractor"}>
            {Object.entries(vehicleKindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="formGrid">
          <label>
            Plate (optional)
            <input
              name="plate"
              maxLength={20}
              defaultValue={vehicle?.plate}
              autoComplete="off"
            />
          </label>
          <label>
            VIN (optional)
            <input
              name="vin"
              maxLength={17}
              defaultValue={vehicle?.vin}
              autoComplete="off"
              pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{17}|"
              title="17 letters and digits, without I, O or Q"
            />
          </label>
        </div>
        {error && (
          <div className="alert error" role="alert">
            {describe(error)}
          </div>
        )}
        <div className="formActions">
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : vehicle ? "Save changes" : "Add vehicle"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** The vehicle choice beside the driver on a load's assignment form. It shows
 *  only when the carrier has vehicles; a load keeps a retired vehicle it is
 *  already on, but a retired one cannot be picked again. */
export function AssignVehicleSelect({
  carrierId,
  current,
  currentLabel,
}: {
  carrierId: string;
  current: string;
  currentLabel: string;
}) {
  const api = useApi();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  useEffect(() => {
    let stale = false;
    api<Fleet>("fleet?carrier_id=" + carrierId)
      .then((f) => !stale && setVehicles(f.vehicles))
      // The fleet is a convenience here: without it the driver still saves.
      .catch(() => !stale && setVehicles([]));
    return () => {
      stale = true;
    };
  }, [api, carrierId]);
  if (!vehicles?.length) return null;
  const active = vehicles.filter((v) => v.status === "active");
  const keepsRetired =
    !!current && !active.some((v) => v.id === current) && !!currentLabel;
  return (
    <label>
      <span className="srOnly">Vehicle</span>
      <select name="vehicle" defaultValue={current}>
        <option value="">No vehicle</option>
        {keepsRetired && (
          <option value={current}>{currentLabel} (retired)</option>
        )}
        {active.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    </label>
  );
}
