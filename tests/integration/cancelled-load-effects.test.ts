import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/lib/db";
import { detail, mutate } from "../../src/lib/loads";
import { cancelLoad } from "../../src/lib/load-changes";
import { removeTeamMember } from "../../src/lib/account";
import { billingOverview } from "../../src/lib/billing";
import { bookedLoad, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("CancelledEffects");
});
after(() => pool.end());

const rows = async (sql: string, ...args: unknown[]) =>
  (await pool.query(sql, args)).rows;

test("a cancelled load no longer holds its driver or appears in billing", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.otherDriver,
  });
  await assert.rejects(
    removeTeamMember(t.manager, t.carrier, {
      driver_id: t.otherDriver,
      reason: "Left the company",
    }),
    { code: "DRIVER_HAS_ACTIVE_LOADS" },
  );
  const v = (await detail(t.dispatcher, load.id)).version;
  await cancelLoad(t.dispatcher, load.id, { version: v, reason: "Cancelled" });
  // The assignment stays as history, but no longer blocks removing the driver.
  assert.equal(
    (await rows("SELECT 1 FROM load_assignments WHERE load_id=$1", load.id))
      .length,
    1,
  );
  const overview = await billingOverview(
    t.dispatcher,
    new URLSearchParams({ carrier_id: t.carrier }),
  );
  assert.ok(!JSON.stringify(overview).includes(load.id));
  await removeTeamMember(t.manager, t.carrier, {
    driver_id: t.otherDriver,
    reason: "Left the company",
  });
});
