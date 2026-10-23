// The browser-only demo of the fleet page (ADR 0048). It mirrors the rules in
// src/lib/fleet.ts (unique unit names per carrier, versioned edits, retire and
// reactivate) so the demo and the app behave alike, but nothing is saved
// outside this browser and every record is fictional.

// Mirrors vehicleKinds in src/lib/fleet.ts, which cannot be imported here
// because that file reaches the database.
const kinds = [
  "tractor",
  "straight_truck",
  "box_truck",
  "cargo_van",
  "sprinter_van",
  "trailer",
  "other",
];

export type DemoVehicle = {
  id: string;
  carrier_id: string;
  label: string;
  kind: string;
  plate: string;
  vin: string;
  status: "active" | "retired";
  version: number;
};

type DemoDriver = {
  id: string;
  name: string;
  email: string | null;
  onboarding_status: string;
  phone: string;
};

export function seedVehicles(carrierIds: string[]): DemoVehicle[] {
  const make = (
    n: number,
    carrier_id: string,
    label: string,
    kind: string,
    plate: string,
    status: DemoVehicle["status"] = "active",
  ): DemoVehicle => ({
    id: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`,
    carrier_id,
    label,
    kind,
    plate,
    vin: "",
    status,
    version: 1,
  });
  const [first, second] = carrierIds;
  return [
    make(1, first, "Unit 12", "tractor", "DEMO 120"),
    make(2, first, "Box 4", "box_truck", "DEMO 044"),
    make(3, first, "Unit 7", "trailer", "DEMO 007", "retired"),
    make(4, second, "Van 2", "cargo_van", "DEMO 202"),
  ];
}

type Deps = {
  fail: (code: string, status?: number) => never;
  /** The carrier's setup record, or a 404 for a carrier this person cannot see. */
  carrier: (id: string) => {
    carrier: { id: string; name: string };
    drivers?: DemoDriver[];
  };
  /** Loads not yet delivered for a driver or a vehicle. */
  activeLoads: (id: string, kind: "driver" | "vehicle") => number;
  canView: boolean;
};

const clean = (data: Record<string, unknown>, fail: Deps["fail"]) => {
  const label = String(data.label ?? "").trim();
  const kind = String(data.kind ?? "");
  const plate = String(data.plate ?? "")
    .trim()
    .toUpperCase();
  const vin = String(data.vin ?? "")
    .trim()
    .toUpperCase();
  if (
    !label ||
    label.length > 60 ||
    !kinds.includes(kind) ||
    plate.length > 20 ||
    (vin !== "" && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
  )
    fail("VALIDATION_ERROR", 400);
  return { label, kind, plate, vin };
};

/** GET fleet, POST fleet/vehicles, PATCH fleet/vehicles/:id and
 *  fleet/vehicles/:id/status; the path says which (the demo has no verbs). */
export function fleetRequest(
  vehicles: DemoVehicle[],
  deps: Deps,
  p: string[],
  data: Record<string, unknown> | undefined,
  url: URL,
): unknown {
  const { fail } = deps;
  if (!deps.canView) fail("NOT_FOUND", 404);
  const taken = (carrierId: string, label: string, except?: string) =>
    vehicles.some(
      (v) =>
        v.carrier_id === carrierId &&
        v.id !== except &&
        v.label.toLowerCase() === label.toLowerCase(),
    );
  const shape = (v: DemoVehicle) => ({
    id: v.id,
    label: v.label,
    kind: v.kind,
    plate: v.plate,
    vin: v.vin,
    status: v.status,
    version: v.version,
    active_loads: deps.activeLoads(v.id, "vehicle"),
  });

  if (p.length === 1) {
    const setup = deps.carrier(url.searchParams.get("carrier_id") ?? "");
    return {
      carrier: { id: setup.carrier.id, name: setup.carrier.name },
      can_edit: true,
      drivers: (setup.drivers ?? [])
        .filter((d) => d.onboarding_status !== "removed")
        .map((d) => ({
          id: d.id,
          name: d.name,
          status: d.onboarding_status === "ready" ? "ready" : "pending",
          phone: d.phone,
          email: d.email,
          active_loads: deps.activeLoads(d.id, "driver"),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      vehicles: vehicles
        .filter((v) => v.carrier_id === setup.carrier.id)
        .sort(
          (a, b) =>
            Number(a.status === "retired") - Number(b.status === "retired") ||
            a.label.toLowerCase().localeCompare(b.label.toLowerCase()),
        )
        .map(shape),
    };
  }
  if (p[1] !== "vehicles" || !data) return fail("NOT_FOUND", 404);

  if (p.length === 2) {
    const setup = deps.carrier(String(data.carrier_id ?? ""));
    const fields = clean(data, fail);
    if (taken(setup.carrier.id, fields.label)) fail("DUPLICATE_VEHICLE", 409);
    const id = crypto.randomUUID();
    vehicles.push({
      id,
      carrier_id: setup.carrier.id,
      ...fields,
      status: "active",
      version: 1,
    });
    return { id, version: 1 };
  }

  // A vehicle of a carrier this person cannot see reads as missing.
  const vehicle = vehicles.find((v) => v.id === p[2]);
  if (!vehicle) return fail("NOT_FOUND", 404);
  deps.carrier(vehicle.carrier_id);
  if (data.version !== vehicle.version) fail("VERSION_CONFLICT", 409);
  if (p[3] === "status") {
    if (data.status !== "active" && data.status !== "retired")
      return fail("VALIDATION_ERROR", 400);
    vehicle.status = data.status;
  } else {
    const fields = clean(data, fail);
    if (taken(vehicle.carrier_id, fields.label, vehicle.id))
      fail("DUPLICATE_VEHICLE", 409);
    Object.assign(vehicle, fields);
  }
  vehicle.version += 1;
  return { id: vehicle.id, version: vehicle.version };
}
