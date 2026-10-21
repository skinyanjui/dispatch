import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { access, collect } from "./contacts";
import { scoped } from "./loads";
import { appOrigin, enqueueForEmail, enqueueForUser } from "./notifications";
import { smsTransport, toE164 } from "./sms";
import type { DirectoryEntry } from "./contact-types";

// Inbox (ADR 0018): conversations with in-app, email and text messages that
// Relay sends, plus emails, texts and calls logged by hand.
const channels = ["in_app", "email", "sms", "call"] as const;
const keyPattern = /^(user|driver|carrier|contact):[0-9a-f-]{36}$/;
export const smsMaxLength = 480;

export const sendSchema = z
  .object({
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
    thread_id: z.uuid().optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    load_id: z.uuid().optional(),
    carrier_id: z.uuid().optional(),
    to: z.array(z.string().regex(keyPattern)).min(1).max(25),
    channel: z.enum(channels),
    mode: z.enum(["send", "log"]).default("send"),
    direction: z.enum(["out", "in"]).default("out"),
    counterpart: z.string().trim().max(160).default(""),
    body: z.string().trim().min(1).max(5000),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((d) => d.thread_id || d.subject, {
    message: "A new conversation needs a subject",
    path: ["subject"],
  })
  .refine(
    (d) => d.mode === "log" || (d.direction === "out" && d.channel !== "call"),
    {
      message: "Relay sends outgoing in-app, email and text messages only",
      path: ["mode"],
    },
  )
  .refine(
    (d) =>
      d.mode === "log" || d.channel !== "sms" || d.body.length <= smsMaxLength,
    {
      message: `Texts are limited to ${smsMaxLength} characters`,
      path: ["body"],
    },
  )
  .refine((d) => d.mode === "send" || d.channel !== "in_app", {
    message: "Only calls, texts and emails are logged by hand",
    path: ["channel"],
  })
  .refine((d) => d.mode === "log" || !d.occurred_at, {
    message: "Only logged entries take a time",
    path: ["occurred_at"],
  });

type Resolved = {
  key: string;
  userId: string | null;
  name: string;
  email: string;
  phone: string;
  smsOk: boolean;
  entry: DirectoryEntry;
};

/** Drivers resolve to their account so they can receive in-app messages. */
async function resolveRecipients(
  c: PoolClient,
  user: string,
  keys: string[],
): Promise<Resolved[]> {
  const visible = new Map(
    (await collect(user, {})).list.map((e) => [e.key, e]),
  );
  // A driver is listed as driver:<id>, but replies to a driver's own message
  // address them as user:<id>; both name the same person.
  const driverIds = [...visible.keys()]
    .filter((k) => k.startsWith("driver:"))
    .map((k) => k.slice(7));
  const byUser = new Map<string, DirectoryEntry>();
  if (driverIds.length)
    for (const row of (
      await c.query(
        "SELECT driver_id,user_id FROM memberships WHERE driver_id=ANY($1::uuid[]) AND user_id IS NOT NULL",
        [driverIds],
      )
    ).rows)
      byUser.set(
        "user:" + row.user_id,
        visible.get("driver:" + row.driver_id)!,
      );
  const out: Resolved[] = [];
  const seenUsers = new Set<string>();
  for (const key of [...new Set(keys)]) {
    const entry = visible.get(key) ?? byUser.get(key);
    if (!entry) throw new HttpError(404, "NOT_FOUND");
    let userId: string | null = null;
    if (key.startsWith("user:")) userId = key.slice(5);
    else if (key.startsWith("driver:")) {
      const { rows } = await c.query(
        "SELECT user_id FROM memberships WHERE driver_id=$1 LIMIT 1",
        [key.slice(7)],
      );
      userId = rows[0]?.user_id ?? null;
    }
    if (userId) {
      if (seenUsers.has(userId)) continue;
      seenUsers.add(userId);
    }
    out.push({
      key,
      userId,
      name: entry.name,
      email: entry.email,
      phone: entry.phone,
      smsOk: entry.sms_ok,
      entry,
    });
  }
  return out;
}

/** Visibility of a thread: participants, its creator, dispatchers of its carrier, org admins. */
const visibleThread = `(
  t.created_by=$1
  OR EXISTS(SELECT 1 FROM thread_participants p WHERE p.thread_id=t.id AND p.user_id=$1)
  OR (t.carrier_id IS NOT NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.carrier_id=t.carrier_id AND m.role='dispatcher'))
  OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=t.organization_id AND om.user_id=$1))`;

async function lockThread(c: PoolClient, user: string, id: string) {
  const { rows } = await c.query(
    `SELECT t.* FROM threads t WHERE t.id=$2 AND ${visibleThread} FOR UPDATE OF t`,
    [user, id],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0];
}

export async function sendMessage(
  user: string,
  input: unknown,
  origin?: string,
) {
  const data = sendSchema.parse(input);
  const { idempotency_key, ...rest } = data;
  const hash = digest(JSON.stringify({ ...rest, to: [...rest.to].sort() }));
  const sms = data.mode === "send" && data.channel === "sms";
  const transport = sms ? smsTransport() : null;
  if (sms && !transport) throw new HttpError(409, "SMS_UNAVAILABLE");
  const result = await transaction(async (c) => {
    const a = await access(c, user);
    const staff =
      a.dispatchCarriers.length + a.managerCarriers.length > 0 ||
      a.organizations.length > 0;
    // Drivers message their team in Relay; email, texts and logging are for staff.
    if (!staff && (data.mode === "log" || data.channel !== "in_app"))
      throw new HttpError(403, "ROLE_NOT_PERMITTED");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":message:" + idempotency_key,
    ]);
    const old = await c.query(
      "SELECT id,thread_id,request_hash FROM messages WHERE sender_user_id=$1 AND idempotency_key=$2",
      [user, idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return {
        thread_id: old.rows[0].thread_id as string,
        message_id: old.rows[0].id as string,
        replay: true,
        deliveries: [] as { id: string; key: string; address: string }[],
      };
    }
    const recipients = await resolveRecipients(c, user, data.to);
    if (data.mode === "send") {
      const bad = recipients.filter((r) =>
        data.channel === "in_app"
          ? !r.userId || r.userId === user
          : data.channel === "email"
            ? !r.email
            : !(r.smsOk && toE164(r.phone)),
      );
      if (bad.length) throw new HttpError(422, "RECIPIENT_CHANNEL_UNAVAILABLE");
    }
    // Thread: existing (must be visible) or new (scope from load, carrier or recipients).
    let thread;
    if (data.thread_id) thread = await lockThread(c, user, data.thread_id);
    else {
      let carrierId: string | null = null,
        organizationId: string | null = null;
      if (data.load_id) {
        const load = await scoped(c, user, data.load_id);
        carrierId = load.carrier_id;
      } else if (data.carrier_id) {
        const m = await c.query(
          "SELECT 1 FROM memberships WHERE user_id=$1 AND carrier_id=$2",
          [user, data.carrier_id],
        );
        if (
          !m.rowCount &&
          !(
            await c.query(
              "SELECT 1 FROM carriers ca JOIN organization_members om ON om.organization_id=ca.organization_id WHERE ca.id=$2 AND om.user_id=$1",
              [user, data.carrier_id],
            )
          ).rowCount
        )
          throw new HttpError(404, "NOT_FOUND");
        carrierId = data.carrier_id;
      } else {
        // The carrier all recipients share with the sender, when there is exactly one.
        const shared = recipients
          .flatMap((r) => r.entry.carriers.map((x) => x.id))
          .filter((id) =>
            [
              ...a.dispatchCarriers,
              ...a.managerCarriers,
              ...a.driverCarriers,
            ].includes(id),
          );
        const counts = new Map<string, number>();
        for (const id of shared) counts.set(id, (counts.get(id) ?? 0) + 1);
        const common = [...counts].filter(
          ([, n]) =>
            n >= recipients.filter((r) => r.entry.carriers.length).length,
        );
        if (
          common.length === 1 &&
          recipients.some((r) => r.entry.carriers.length)
        )
          carrierId = common[0][0];
      }
      if (carrierId) {
        organizationId = (
          await c.query("SELECT organization_id FROM carriers WHERE id=$1", [
            carrierId,
          ])
        ).rows[0].organization_id;
      } else {
        // Organization-wide: external contacts and staff of one organization.
        const external = recipients.find((r) => r.entry.contact);
        organizationId =
          (external &&
            (
              await c.query(
                "SELECT organization_id FROM contacts WHERE id=$1",
                [external.entry.contact!.id],
              )
            ).rows[0]?.organization_id) ||
          a.organizations[0] ||
          null;
        if (!organizationId) throw new HttpError(422, "THREAD_SCOPE_UNKNOWN");
        if (!a.organizations.includes(organizationId))
          throw new HttpError(404, "NOT_FOUND");
      }
      const id = randomUUID();
      await c.query(
        "INSERT INTO threads(id,organization_id,carrier_id,load_id,subject,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          organizationId,
          carrierId,
          data.load_id ?? null,
          data.subject,
          user,
        ],
      );
      thread = (await c.query("SELECT * FROM threads WHERE id=$1", [id]))
        .rows[0];
    }
    // Participants: the sender plus everyone addressed.
    const me = (
      await c.query("SELECT name,email,phone FROM users WHERE id=$1", [user])
    ).rows[0];
    const people: {
      key: string;
      userId: string | null;
      name: string;
      email: string;
      phone: string;
    }[] = [
      {
        key: "user:" + user,
        userId: user,
        name: me.name,
        email: me.email,
        phone: me.phone,
      },
      ...recipients.map((r) => ({
        key: r.key,
        userId: r.userId,
        name: r.name,
        email: r.email,
        phone: r.phone,
      })),
    ];
    for (const p of people)
      await c.query(
        `INSERT INTO thread_participants(thread_id,participant_key,user_id,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(thread_id,participant_key) DO UPDATE SET user_id=COALESCE(thread_participants.user_id,EXCLUDED.user_id)`,
        [thread.id, p.key, p.userId, p.name, p.email, p.phone],
      );
    const messageId = randomUUID();
    const occurred = data.occurred_at ? new Date(data.occurred_at) : new Date();
    if (
      data.mode === "log" &&
      (occurred.getTime() > Date.now() + 5 * 60_000 ||
        occurred.getTime() < Date.now() - 90 * 86_400_000)
    )
      throw new HttpError(422, "LOG_TIME_OUT_OF_RANGE");
    await c.query(
      `INSERT INTO messages(id,thread_id,sender_user_id,channel,direction,source,body,counterpart,occurred_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        messageId,
        thread.id,
        user,
        data.channel,
        data.mode === "send" ? "out" : data.direction,
        data.mode === "send" ? "relay" : "logged",
        data.body,
        data.direction === "in"
          ? data.counterpart || recipients.map((r) => r.name).join(", ")
          : "",
        occurred,
        idempotency_key,
        hash,
      ],
    );
    const deliveries: { id: string; key: string; address: string }[] = [];
    if (data.mode === "send") {
      const origin_ = appOrigin(origin);
      for (const r of recipients) {
        const id = randomUUID();
        let status = "delivered",
          notification: string | null = null,
          address = "";
        if (data.channel === "email") {
          status = "pending";
          address = r.email;
          notification =
            (await enqueueForEmail(c, r.email, {
              kind: "message",
              organization: thread.organization_id,
              dedupe: `message:${messageId}:${r.key}`,
              subject: thread.subject,
              text: `${data.body}\n\n—\nSent by ${me.name} through Relay. Reply to this email to reach ${me.name} at ${me.email}.`,
              replyTo: me.email,
            })) ?? null;
        } else if (data.channel === "sms") {
          status = "pending";
          address = toE164(r.phone)!;
        } else if (r.userId) {
          address = r.email;
          await enqueueForUser(c, r.userId, {
            kind: "message_received",
            organization: thread.organization_id,
            dedupe: `message_received:${messageId}:${r.userId}`,
            subject: `New message from ${me.name}: ${thread.subject}`.slice(
              0,
              200,
            ),
            text: `${me.name} sent you a message in Relay: “${thread.subject}”.\n\nOpen your inbox: ${origin_}`,
          });
        }
        await c.query(
          "INSERT INTO message_deliveries(id,message_id,participant_key,channel,address,status,notification_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, messageId, r.key, data.channel, address, status, notification],
        );
        deliveries.push({ id, key: r.key, address });
      }
    }
    await c.query(
      "UPDATE threads SET last_message_at=$2 WHERE id=$1 AND last_message_at<$2",
      [thread.id, occurred],
    );
    await c.query(
      "INSERT INTO thread_reads(thread_id,user_id,last_read_at) VALUES($1,$2,now()) ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_at=now()",
      [thread.id, user],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      data.mode === "log" ? "message.logged" : "message.sent",
      messageId,
    ]);
    return {
      thread_id: thread.id as string,
      message_id: messageId,
      deliveries,
      replay: false,
    };
  });
  // Texts leave only after the record is committed; each is attempted once.
  if (!result.replay && transport) {
    for (const d of result.deliveries) {
      const outcome = await transport.send(d.address, data.body);
      await pool.query(
        "UPDATE message_deliveries SET status=$2,provider_message_id=$3,last_error=$4,updated_at=now() WHERE id=$1",
        [
          d.id,
          outcome.ok ? "sent" : outcome.definite ? "failed" : "unknown",
          outcome.ok ? outcome.providerId : null,
          outcome.ok ? null : outcome.error,
        ],
      );
    }
  }
  return { thread_id: result.thread_id, message_id: result.message_id };
}

// ---------- Reading ----------

const deliveryStatus = `CASE d.channel
  WHEN 'email' THEN CASE n.status WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' WHEN 'suppressed' THEN 'not_sent' ELSE 'queued' END
  WHEN 'sms' THEN CASE d.status WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' WHEN 'unknown' THEN 'unknown' ELSE 'queued' END
  ELSE 'delivered' END`;

export const threadFilters = z
  .object({
    q: z.string().trim().max(100).optional(),
    filter: z.enum(["all", "unread"]).default("all"),
    channel: z.enum(channels).optional(),
    load_id: z.uuid().optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

const unreadSql = `EXISTS(
  SELECT 1 FROM thread_participants me WHERE me.thread_id=t.id AND me.user_id=$1)
  AND EXISTS(SELECT 1 FROM messages m LEFT JOIN thread_reads r ON r.thread_id=t.id AND r.user_id=$1
    WHERE m.thread_id=t.id AND m.sender_user_id<>$1 AND m.occurred_at>COALESCE(r.last_read_at,'-infinity'))`;

export async function listThreads(user: string, params: URLSearchParams) {
  const f = threadFilters.parse({
    q: params.get("q") ?? undefined,
    filter: params.get("filter") ?? undefined,
    channel: params.get("channel") ?? undefined,
    load_id: params.get("load_id") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
  });
  let cursor: { at: string; id: string } | null = null;
  if (f.cursor)
    try {
      cursor = z
        .object({ at: z.string().max(40), id: z.uuid() })
        .parse(JSON.parse(Buffer.from(f.cursor, "base64url").toString()));
      if (Number.isNaN(Date.parse(cursor.at))) throw new Error();
    } catch {
      throw new HttpError(400, "INVALID_CURSOR");
    }
  const like = f.q ? "%" + f.q.replace(/[\\%_]/g, (m) => "\\" + m) + "%" : null;
  const { rows } = await pool.query(
    `SELECT t.id,t.subject,t.created_at,t.last_message_at::text cursor_at,t.last_message_at,t.load_id,l.reference load_reference,
      c.name carrier_name,(${unreadSql}) unread,
      (SELECT count(*)::int FROM messages m WHERE m.thread_id=t.id) message_count,
      (SELECT COALESCE(json_agg(p.name ORDER BY p.name),'[]') FROM (SELECT name FROM thread_participants p WHERE p.thread_id=t.id AND (p.user_id IS DISTINCT FROM $1) ORDER BY name LIMIT 4) p) with_names,
      (SELECT json_build_object('channel',m.channel,'direction',m.direction,'source',m.source,'preview',left(m.body,140),'sender',u.name,'occurred_at',m.occurred_at)
        FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.thread_id=t.id ORDER BY m.occurred_at DESC,m.id DESC LIMIT 1) last
    FROM threads t LEFT JOIN loads l ON l.id=t.load_id LEFT JOIN carriers c ON c.id=t.carrier_id
    WHERE ${visibleThread}
      AND ($2::uuid IS NULL OR t.load_id=$2)
      AND ($3::text IS NULL OR t.subject ILIKE $3
        OR EXISTS(SELECT 1 FROM thread_participants p WHERE p.thread_id=t.id AND p.name ILIKE $3)
        OR EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND m.body ILIKE $3))
      AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND m.channel=$4))
      AND ($5::boolean IS NOT TRUE OR (${unreadSql}))
      AND ($6::timestamptz IS NULL OR (t.last_message_at,t.id)<($6,$7::uuid))
    ORDER BY t.last_message_at DESC,t.id DESC LIMIT 31`,
    [
      user,
      f.load_id ?? null,
      like,
      f.channel ?? null,
      f.filter === "unread",
      cursor?.at ?? null,
      cursor?.id ?? null,
    ],
  );
  const page = rows.slice(0, 30);
  const last = page[page.length - 1];
  return {
    threads: page.map(({ cursor_at, ...t }) => {
      void cursor_at;
      return t;
    }),
    nextCursor:
      rows.length > 30
        ? Buffer.from(
            JSON.stringify({ at: last.cursor_at, id: last.id }),
          ).toString("base64url")
        : null,
  };
}

export async function unreadCount(user: string) {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM threads t WHERE ${visibleThread} AND (${unreadSql})`,
    [user],
  );
  return { unread: rows[0].n as number };
}

export async function getThread(user: string, id: string) {
  return transaction(async (c) => {
    const thread = await lockThread(c, user, id);
    const participants = await c.query(
      "SELECT participant_key key,name,email,phone,user_id FROM thread_participants WHERE thread_id=$1 ORDER BY name",
      [id],
    );
    const messages = await c.query(
      `SELECT m.id,m.channel,m.direction,m.source,m.body,m.counterpart,m.occurred_at,m.sender_user_id,u.name sender_name,
        (SELECT COALESCE(json_agg(json_build_object('key',d.participant_key,'name',p.name,'channel',d.channel,'status',${deliveryStatus},
          'error',COALESCE(d.last_error,n.last_error)) ORDER BY p.name),'[]')
          FROM message_deliveries d LEFT JOIN notifications n ON n.id=d.notification_id
          LEFT JOIN thread_participants p ON p.thread_id=m.thread_id AND p.participant_key=d.participant_key
          WHERE d.message_id=m.id) deliveries
      FROM messages m JOIN users u ON u.id=m.sender_user_id
      WHERE m.thread_id=$1 ORDER BY m.occurred_at DESC,m.id DESC LIMIT 200`,
      [id],
    );
    const load = thread.load_id
      ? (
          await c.query("SELECT id,reference FROM loads WHERE id=$1", [
            thread.load_id,
          ])
        ).rows[0]
      : null;
    return {
      id: thread.id as string,
      subject: thread.subject as string,
      carrier_id: thread.carrier_id as string | null,
      load,
      participants: participants.rows,
      messages: messages.rows.reverse(),
    };
  });
}

export async function markRead(user: string, id: string) {
  return transaction(async (c) => {
    await lockThread(c, user, id);
    await c.query(
      "INSERT INTO thread_reads(thread_id,user_id,last_read_at) VALUES($1,$2,now()) ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_at=now()",
      [id, user],
    );
    return { ok: true };
  });
}

// ---------- Saved replies ----------

export const savedReplySchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(2000),
    shared: z.boolean().default(false),
  })
  .strict();

async function staffOrganizations(c: PoolClient | typeof pool, user: string) {
  return (await access(c, user)).organizations;
}

export async function listSavedReplies(user: string) {
  const orgs = await staffOrganizations(pool, user);
  const { rows } = await pool.query(
    `SELECT r.id,r.title,r.body,r.shared,(r.owner_id=$1) mine,u.name owner_name
    FROM saved_replies r JOIN users u ON u.id=r.owner_id
    WHERE r.owner_id=$1 OR (r.shared AND r.organization_id=ANY($2::uuid[]))
    ORDER BY lower(r.title),r.id LIMIT 200`,
    [user, orgs],
  );
  return { replies: rows, can_share: orgs.length > 0 };
}

export async function createSavedReply(user: string, input: unknown) {
  const data = savedReplySchema.parse(input);
  const orgs = await staffOrganizations(pool, user);
  if (data.shared && !orgs.length)
    throw new HttpError(403, "ROLE_NOT_PERMITTED");
  const id = randomUUID();
  await pool.query(
    "INSERT INTO saved_replies(id,organization_id,owner_id,shared,title,body) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      data.shared ? orgs[0] : null,
      user,
      data.shared,
      data.title,
      data.body,
    ],
  );
  return { id };
}

async function ownReply(user: string, id: string) {
  const orgs = await staffOrganizations(pool, user);
  const { rows } = await pool.query(
    "SELECT * FROM saved_replies WHERE id=$1 AND (owner_id=$2 OR (shared AND organization_id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=saved_replies.organization_id AND om.user_id=$2)))",
    [id, user, orgs],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0];
}
export async function updateSavedReply(
  user: string,
  id: string,
  input: unknown,
) {
  const data = savedReplySchema.pick({ title: true, body: true }).parse(input);
  await ownReply(user, id);
  await pool.query(
    "UPDATE saved_replies SET title=$2,body=$3,updated_at=now() WHERE id=$1",
    [id, data.title, data.body],
  );
  return { id };
}
export async function deleteSavedReply(user: string, id: string) {
  await ownReply(user, id);
  await pool.query("DELETE FROM saved_replies WHERE id=$1", [id]);
  return { ok: true };
}
