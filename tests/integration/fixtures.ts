import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { pool } from "../../src/lib/db";
import { digest } from "../../src/lib/auth";
import { createLoad } from "../../src/lib/loads";

export const origin = "http://localhost:3000";

/**
 * Fictional tenant with two carriers. `carrier` is the subject; `foreign` is a
 * carrier the manager/driver must never reach. The dispatcher works both.
 */
export async function tenant(label: string) {
  const ids = {
    organization: randomUUID(),
    carrier: randomUUID(),
    foreign: randomUUID(),
    dispatcher: randomUUID(),
    manager: randomUUID(),
    foreignManager: randomUUID(),
    driverUser: randomUUID(),
    otherDriverUser: randomUUID(),
    driver: randomUUID(),
    otherDriver: randomUUID(),
  };
  await pool.query("INSERT INTO organizations VALUES($1,$2)", [
    ids.organization,
    label + " QA",
  ]);
  for (const id of [ids.carrier, ids.foreign]) {
    await pool.query("INSERT INTO carriers VALUES($1,$2,$3)", [
      id,
      ids.organization,
      label + " carrier " + id.slice(0, 4),
    ]);
    await pool.query(
      "INSERT INTO carrier_dispatch_authorizations(id,carrier_id,agreement_ref,verified_at,effective_at,expires_at) VALUES($1,$2,'Fictional QA agreement',now(),now()-interval '1 day',now()+interval '1 year')",
      [randomUUID(), id],
    );
  }
  for (const [id, name] of [
    [ids.dispatcher, "Dispatcher"],
    [ids.manager, "Manager"],
    [ids.foreignManager, "Foreign manager"],
    [ids.driverUser, "Driver"],
    [ids.otherDriverUser, "Other driver"],
  ])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'not-a-login-fixture',$3)",
      [id, id + "@relay.test", label + " " + name],
    );
  for (const [user, carrierId, role] of [
    [ids.dispatcher, ids.carrier, "dispatcher"],
    [ids.dispatcher, ids.foreign, "dispatcher"],
    [ids.manager, ids.carrier, "carrier-manager"],
    [ids.foreignManager, ids.foreign, "carrier-manager"],
  ])
    await pool.query("INSERT INTO memberships VALUES($1,$2,$3,NULL)", [
      user,
      carrierId,
      role,
    ]);
  for (const [driverId, user] of [
    [ids.driver, ids.driverUser],
    [ids.otherDriver, ids.otherDriverUser],
  ]) {
    await pool.query(
      "INSERT INTO drivers(id,carrier_id,name) VALUES($1,$2,$3)",
      [driverId, ids.carrier, label + " driver"],
    );
    await pool.query("INSERT INTO memberships VALUES($1,$2,'driver',$3)", [
      user,
      ids.carrier,
      driverId,
    ]);
  }
  return ids;
}

export async function bookedLoad(
  dispatcher: string,
  carrierId: string,
  options: { pickupHoursFromNow?: number } = {},
) {
  const start = Date.now() + (options.pickupHoursFromNow ?? 48) * 3600000;
  return createLoad(
    dispatcher,
    {
      carrierId,
      reference: "QA-" + randomUUID().slice(0, 8),
      source: "Fictional integration QA",
      amountMinor: 250000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: new Date(start).toISOString(),
          windowEnd: new Date(start + 3600000).toISOString(),
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: new Date(start + 86400000).toISOString(),
          windowEnd: new Date(start + 90000000).toISOString(),
        },
      ],
    },
    randomUUID(),
  );
}

export async function sessionFor(user: string) {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [digest(token), user],
  );
  return token;
}

export function request(
  path: string,
  init: {
    method?: string;
    token?: string;
    json?: unknown;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
) {
  return new NextRequest(origin + "/api/" + path, {
    method: init.method || (init.json || init.body ? "POST" : "GET"),
    headers: {
      origin,
      ...(init.json ? { "content-type": "application/json" } : {}),
      ...(init.token ? { cookie: "relay_session=" + init.token } : {}),
      ...init.headers,
    },
    body: init.json ? JSON.stringify(init.json) : init.body,
  });
}

export const pdf = (text = randomUUID()) =>
  Buffer.from("%PDF-1.4\n% fictional QA " + text + "\n%%EOF\n");
