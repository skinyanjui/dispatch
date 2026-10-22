import { z } from "zod";
import { transaction } from "@/lib/db";
import { HttpError } from "@/lib/auth";
import { carrierAccess, emit, once } from "@/lib/onboarding";

/**
 * A carrier's drivers and vehicles in one place (ADR 0048). Drivers are still
 * added, invited and removed through carrier setup (a driver is a person with a
 * login); this adds the vehicle records and the read view over both.
 */
export const vehicleKinds = [
  "tractor",
  "straight_truck",
  "box_truck",
  "cargo_van",
  "sprinter_van",
  "trailer",
  "other",
] as const;

const key = z.uuid();
const fields = {
  label: z.string().trim().min(1).max(60),
  kind: z.enum(vehicleKinds),
  plate: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v.toUpperCase()),
  vin: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-HJ-NPR-Z0-9]{17}$/.test(v), {
      message: "A VIN is 17 letters and digits, without I, O or Q.",
    }),
};
const create = z.object({ carrier_id: z.uuid(), ...fields, key }).strict();
const update = z
  .object({ ...fields, version: z.number().int().positive(), key })
  .strict();
const status = z
  .object({
    status: z.enum(["active", "retired"]),
    version: z.number().int().positive(),
    key,
  })
  .strict();

const vehicleRow = (r: Record<string, unknown>) => ({
  id: r.id as string,
  label: r.label as string,
  kind: r.kind as string,
  plate: r.plate as string,
  vin: r.vin as string,
  status: r.status as "active" | "retired",
  version: r.version as number,
  active_loads: (r.active_loads as number) ?? 0,
});

/** Drivers and vehicles of one carrier. Dispatchers and carrier managers only;
 *  drivers and other carriers' people get the same 404 as a missing carrier. */
export async function fleetOverview(user: string, carrierId: string) {
  return transaction(async (c) => {
    const carrier = await carrierAccess(c, user, carrierId);
    const drivers = await c.query(
      `SELECT d.id,d.name,d.onboarding_status status,d.phone,
         COALESCE(d.contact_email,(SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.driver_id=d.id LIMIT 1)) email,
         (SELECT count(*)::int FROM load_assignments a JOIN loads l ON l.id=a.load_id
            WHERE a.driver_id=d.id AND l.stage<>'delivered' AND l.cancelled_at IS NULL) active_loads
       FROM drivers d WHERE d.carrier_id=$1 AND d.onboarding_status<>'removed' ORDER BY d.name,d.id`,
      [carrierId],
    );
    const vehicles = await c.query(
      `SELECT v.*,(SELECT count(*)::int FROM load_assignments a JOIN loads l ON l.id=a.load_id
            WHERE a.vehicle_id=v.id AND l.stage<>'delivered' AND l.cancelled_at IS NULL) active_loads
       FROM vehicles v WHERE v.carrier_id=$1 ORDER BY (v.status='retired'),lower(v.label),v.id`,
      [carrierId],
    );
    return {
      carrier: { id: carrier.id as string, name: carrier.name as string },
      can_edit: true,
      drivers: drivers.rows,
      vehicles: vehicles.rows.map(vehicleRow),
    };
  });
}

function duplicate(e: unknown): never {
  if (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "23505"
  )
    throw new HttpError(409, "DUPLICATE_VEHICLE");
  throw e;
}

export async function createVehicle(user: string, input: unknown) {
  const data = create.parse(input);
  return transaction(async (c) => {
    await carrierAccess(c, user, data.carrier_id);
    return once(c, user, data.key, "vehicle.create", data, async () => {
      const id = crypto.randomUUID();
      try {
        await c.query(
          "INSERT INTO vehicles(id,carrier_id,label,kind,plate,vin) VALUES($1,$2,$3,$4,$5,$6)",
          [id, data.carrier_id, data.label, data.kind, data.plate, data.vin],
        );
      } catch (e) {
        duplicate(e);
      }
      await emit(c, user, data.carrier_id, "vehicle.created", {
        vehicle_id: id,
        label: data.label,
      });
      return { id, version: 1 };
    });
  });
}

/** Loads the vehicle for update: scoped to a carrier the person works for. */
async function vehicleFor(
  c: import("pg").PoolClient,
  user: string,
  id: string,
) {
  const v = await c.query(
    `SELECT v.* FROM vehicles v JOIN memberships m ON m.carrier_id=v.carrier_id AND m.user_id=$2
     WHERE v.id=$1 AND m.role IN ('dispatcher','carrier-manager') FOR UPDATE OF v`,
    [id, user],
  );
  if (!v.rows[0]) throw new HttpError(404, "NOT_FOUND");
  return v.rows[0];
}

export async function updateVehicle(user: string, id: string, input: unknown) {
  const data = update.parse(input);
  return transaction(async (c) => {
    const v = await vehicleFor(c, user, id);
    return once(c, user, data.key, "vehicle.update:" + id, data, async () => {
      if (v.version !== data.version)
        throw new HttpError(409, "VERSION_CONFLICT");
      try {
        await c.query(
          `UPDATE vehicles SET label=$2,kind=$3,plate=$4,vin=$5,version=version+1,updated_at=now() WHERE id=$1`,
          [id, data.label, data.kind, data.plate, data.vin],
        );
      } catch (e) {
        duplicate(e);
      }
      await emit(c, user, v.carrier_id, "vehicle.updated", {
        vehicle_id: id,
        label: data.label,
      });
      return { id, version: v.version + 1 };
    });
  });
}

/** Retire or bring back a vehicle. A retired vehicle cannot be chosen for a new
 *  assignment; loads it is already on keep it. */
export async function setVehicleStatus(
  user: string,
  id: string,
  input: unknown,
) {
  const data = status.parse(input);
  return transaction(async (c) => {
    const v = await vehicleFor(c, user, id);
    return once(c, user, data.key, "vehicle.status:" + id, data, async () => {
      if (v.version !== data.version)
        throw new HttpError(409, "VERSION_CONFLICT");
      await c.query(
        "UPDATE vehicles SET status=$2,version=version+1,updated_at=now() WHERE id=$1",
        [id, data.status],
      );
      await emit(
        c,
        user,
        v.carrier_id,
        data.status === "retired" ? "vehicle.retired" : "vehicle.reactivated",
        { vehicle_id: id, label: v.label },
      );
      return { id, version: v.version + 1 };
    });
  });
}
