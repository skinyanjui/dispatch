import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool } from "./db";
import { directory } from "./contacts";
import { attentionLoads, listLoads } from "./loads";
import { listExceptions } from "./exceptions";
import { billingOverview } from "./billing";
import { listProspects } from "./prospects";
import { formatMoney } from "./entry";
import { followUpText, stageLabels } from "./prospect-types";
import type { Source } from "./assistant-types";
import { createHash } from "node:crypto";
import { generateDraft, targets, type Target } from "./drafts";

// Tools for the dispatch assistant (ADR 0031, 0040). Every tool runs as the
// signed-in person, through the same scoped functions the screens use, and is
// then limited to the one organization that consented. All tools only read,
// except draft_document, which creates a text draft from one of the
// organization's templates for a person to review. It sends nothing and
// changes no load, document, invoice or record. Tools return compact,
// formatted records so the model works from facts instead of raw rows.

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};
export type ToolResult = { data: unknown; sources: Source[] };

const limit = z.number().int().min(1).max(25).default(15);
const carrierId = z.uuid().optional();

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "loads_needing_attention",
    description:
      "Loads that are late, due soon, have no driver, have paperwork problems or open exceptions, most urgent first, with the reason for each. Use for questions like what needs attention, what is late, or which loads have no driver.",
    input_schema: {
      type: "object",
      properties: {
        carrier_id: {
          type: "string",
          description: "Limit to one carrier (from list_carriers).",
        },
        reason: {
          type: "string",
          enum: ["late", "soon", "no_driver", "paperwork", "exception"],
          description: "Only loads with this reason.",
        },
      },
    },
  },
  {
    name: "find_loads",
    description:
      "Search loads by reference text and/or stage. Returns the next appointment, driver, paperwork and what to do next for each.",
    input_schema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Part of the load reference.",
        },
        stage: {
          type: "string",
          enum: ["booked", "dispatched", "picked-up", "delivered", "cancelled"],
        },
        carrier_id: { type: "string" },
      },
    },
  },
  {
    name: "list_exceptions",
    description:
      "Open or resolved exceptions (delays, missed appointments, missing paperwork) with owner and due time.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "resolved", "all"] },
        overdue_only: { type: "boolean" },
        carrier_id: { type: "string" },
      },
    },
  },
  {
    name: "billing_summary",
    description:
      "Dispatch-service invoices for one carrier (status, due date, total, paid, balance) and carrier freight billing packets. Amounts are US dollars.",
    input_schema: {
      type: "object",
      properties: {
        carrier_id: { type: "string", description: "From list_carriers." },
      },
      required: ["carrier_id"],
    },
  },
  {
    name: "find_prospects",
    description:
      "Prospective carrier clients being courted: stage, owner, next follow-up date. Filter by text, stage or follow-up (overdue, today, week).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        stage: {
          type: "string",
          enum: ["new", "contacted", "qualified", "proposal", "won", "lost"],
        },
        follow_up: { type: "string", enum: ["overdue", "today", "week"] },
      },
    },
  },
  {
    name: "find_contacts",
    description:
      "Brokers, shippers, receivers and other external contacts by name, company, email or phone.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "list_document_templates",
    description:
      "The organization's document templates (for example a check call message, a carrier welcome note, a broker update). Use before draft_document to find the right template and the kind of record it fills from (load, carrier or contact).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "draft_document",
    description:
      "Fill in one document template for one record and save it as a DRAFT for a person to review. Nothing is sent. `template` is a template name or id from list_document_templates. `record` is what to fill it from: a load reference (for a load template), a carrier name (carrier template) or a contact name (contact template). Fields that have no value show as [missing: ...] in the draft; tell the person which are missing.",
    input_schema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Template name or id." },
        record: {
          type: "string",
          description: "Load reference, carrier name or contact name.",
        },
      },
      required: ["template", "record"],
    },
  },
  {
    name: "list_carriers",
    description:
      "The carriers you work with: id, name, whether a verified dispatch agreement is current, and the carrier's contact.",
    input_schema: { type: "object", properties: {} },
  },
];

type Db = Pool | PoolClient;
/** Carriers in this organization that this person works with. */
export async function scopeCarriers(
  db: Db,
  user: string,
  organization: string,
) {
  const { rows } = await db.query(
    `SELECT c.id,c.name FROM carriers c WHERE c.organization_id=$1 AND (
      EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=c.id AND m.user_id=$2 AND m.role='dispatcher')
      OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=c.organization_id AND om.user_id=$2))
    ORDER BY c.name`,
    [organization, user],
  );
  return rows as { id: string; name: string }[];
}

type LoadRow = {
  id: string;
  reference: string;
  carrier_id: string;
  carrier_name: string;
  stage: string;
  amount_minor: string;
  cancelled_at: string | null;
  pickup: string | null;
  delivery: string | null;
  summary: import("./attention").LoadSummary;
};
const loadFact = (l: LoadRow) => ({
  reference: l.reference,
  carrier: l.carrier_name,
  stage: l.cancelled_at ? "cancelled" : l.stage,
  rate: formatMoney(l.amount_minor),
  route: `${l.pickup ?? "?"} to ${l.delivery ?? "?"}`,
  driver: l.summary.driver_name ?? "none assigned",
  next_stop: l.summary.next
    ? `${l.summary.next.label} at ${l.summary.next.address}, window ${l.summary.next.window_start} to ${l.summary.next.window_end} (${l.summary.next.timezone})`
    : "none",
  paperwork: `${l.summary.docs.accepted} accepted, ${l.summary.docs.pending} awaiting review, ${l.summary.docs.rejected} rejected, ${l.summary.docs.missing} missing`,
  open_exceptions: l.summary.exceptions.open,
  attention: l.summary.attention.level,
  reasons: l.summary.attention.reasons.map((r) => r.text),
  next_step: l.summary.attention.next_step,
});
const loadSource = (l: LoadRow): Source => ({
  kind: "load",
  id: l.id,
  label: l.reference,
});

/** Runs one tool for a person inside one organization. Reads, except draft_document. */
export async function runTool(
  user: string,
  organization: string,
  name: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const carriers = await scopeCarriers(pool, user, organization);
  const ids = new Set(carriers.map((c) => c.id));
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const carrierFilter = (value: unknown) => {
    const id = carrierId.parse(value);
    // A carrier outside this organization looks like no data at all.
    if (id && !ids.has(id)) throw new ToolError("No such carrier.");
    return id;
  };
  switch (name) {
    case "loads_needing_attention": {
      const id = carrierFilter(input.carrier_id);
      const params = new URLSearchParams(id ? { carrier_id: id } : {});
      const result = await attentionLoads(user, params);
      const reason = z
        .enum(["late", "soon", "no_driver", "paperwork", "exception"])
        .optional()
        .parse(input.reason);
      const loads = (result.loads as unknown as LoadRow[])
        .filter((l) => ids.has(l.carrier_id))
        .filter(
          (l) =>
            !reason ||
            l.summary.attention.reasons.some((r) => r.key === reason),
        )
        .slice(0, 25);
      return {
        data: {
          shown: loads.length,
          truncated: result.truncated,
          loads: loads.map(loadFact),
        },
        sources: loads.map(loadSource),
      };
    }
    case "find_loads": {
      const params = new URLSearchParams();
      const id = carrierFilter(input.carrier_id);
      if (id) params.set("carrier_id", id);
      if (typeof input.reference === "string" && input.reference.trim())
        params.set("q", input.reference.trim().slice(0, 100));
      if (typeof input.stage === "string") params.set("status", input.stage);
      const { loads } = await listLoads(user, params);
      const rows = (loads as unknown as LoadRow[])
        .filter((l) => ids.has(l.carrier_id))
        .slice(0, 15);
      return {
        data: { shown: rows.length, loads: rows.map(loadFact) },
        sources: rows.map(loadSource),
      };
    }
    case "list_exceptions": {
      const params = new URLSearchParams();
      const id = carrierFilter(input.carrier_id);
      if (id) params.set("carrier_id", id);
      const status = z
        .enum(["active", "resolved", "all"])
        .optional()
        .parse(input.status);
      if (status) params.set("status", status);
      if (input.overdue_only === true) params.set("overdue", "true");
      const { exceptions } = await listExceptions(user, params);
      const rows = (exceptions as unknown as Record<string, string | null>[])
        .filter((e) => ids.has(e.carrier_id as string))
        .slice(0, 25);
      return {
        data: {
          shown: rows.length,
          exceptions: rows.map((e) => ({
            load: e.load_reference,
            carrier: e.carrier_name,
            type: e.type,
            severity: e.severity,
            status: e.status,
            summary: e.summary,
            owner: e.owner_name ?? "unassigned",
            due: e.due_at,
          })),
        },
        sources: rows.map((e) => ({
          kind: "exception" as const,
          id: e.id as string,
          label: `${e.load_reference}: ${e.summary}`.slice(0, 80),
        })),
      };
    }
    case "billing_summary": {
      const id = carrierFilter(input.carrier_id);
      if (!id) throw new ToolError("Choose a carrier (see list_carriers).");
      const overview = await billingOverview(
        user,
        new URLSearchParams({ carrier_id: id }),
      );
      const today = new Date().toISOString().slice(0, 10);
      const invoices = overview.invoices.slice(0, 25).map((i) => {
        const balance =
          i.status === "issued"
            ? BigInt(i.total_minor) - BigInt(i.paid_minor)
            : 0n;
        return {
          number: i.number ?? "draft",
          status:
            i.status === "issued"
              ? balance <= 0n
                ? "paid"
                : i.due_on < today
                  ? "overdue"
                  : "open"
              : i.status,
          due: i.due_on,
          total: formatMoney(i.total_minor),
          paid: formatMoney(i.paid_minor),
          balance: formatMoney(balance.toString()),
          loads: (i.lines ?? []).map((l: { reference: string }) => l.reference),
        };
      });
      const packets = overview.loads
        .filter((l) => l.packet)
        .slice(0, 25)
        .map((l) => ({
          load: l.reference,
          status: l.packet!.status,
          payment: l.packet!.payment_state,
          invoiced: formatMoney(l.packet!.amount_minor),
          received: formatMoney(l.packet!.paid_minor),
        }));
      const uninvoiced = overview.loads
        .filter((l) => l.stage === "delivered" && !l.invoice)
        .map((l) => l.reference);
      return {
        data: {
          carrier: carriers.find((c) => c.id === id)?.name,
          dispatch_invoices: invoices,
          carrier_freight_packets: packets,
          delivered_loads_not_yet_invoiced: uninvoiced,
        },
        sources: [
          ...overview.invoices.slice(0, 25).map((i) => ({
            kind: "invoice" as const,
            id: i.id,
            label: i.number ?? "Draft invoice",
          })),
        ],
      };
    }
    case "find_prospects": {
      const params = new URLSearchParams();
      if (typeof input.query === "string" && input.query.trim())
        params.set("q", input.query.trim().slice(0, 100));
      if (typeof input.stage === "string") params.set("stage", input.stage);
      if (typeof input.follow_up === "string")
        params.set("follow_up", input.follow_up);
      const result = await listProspects(user, params);
      const rows = result.prospects
        .filter((p) => p.organization_id === organization)
        .slice(0, 25);
      return {
        data: {
          shown: rows.length,
          prospects: rows.map((p) => ({
            company: p.company,
            contact: p.contact_name || null,
            stage: stageLabels[p.stage],
            owner: p.owner?.name ?? "no owner",
            follow_up: p.next_follow_up_on
              ? followUpText(p.next_follow_up_on, result.today)
              : "none set",
            source: p.source,
            trucks: p.truck_count,
          })),
        },
        sources: rows.map((p) => ({
          kind: "prospect" as const,
          id: p.id,
          label: p.company,
        })),
      };
    }
    case "find_contacts": {
      const query = z.string().trim().min(1).max(100).parse(input.query);
      const dir = await directory(
        user,
        new URLSearchParams({ q: query, group: "external" }),
      );
      const mine = await pool.query(
        "SELECT id FROM contacts WHERE organization_id=$1 AND archived_at IS NULL",
        [organization],
      );
      const inOrg = new Set(mine.rows.map((r) => r.id as string));
      const rows = dir.entries
        .filter((e) => e.contact && inOrg.has(e.contact.id))
        .slice(0, 15);
      return {
        data: {
          shown: rows.length,
          contacts: rows.map((e) => ({
            name: e.name,
            detail: e.detail,
            email: e.email || null,
            phone: e.phone || null,
          })),
        },
        sources: rows.map((e) => ({
          kind: "contact" as const,
          id: e.contact!.id,
          label: e.name,
        })),
      };
    }
    case "list_document_templates": {
      const { rows } = await pool.query(
        "SELECT id,name,target FROM document_templates WHERE organization_id=$1 AND archived_at IS NULL ORDER BY created_at DESC,id LIMIT 50",
        [organization],
      );
      return {
        data: {
          templates: rows.map((r) => ({
            id: r.id,
            name: r.name,
            fills_from: r.target,
          })),
        },
        sources: [],
      };
    }
    case "draft_document": {
      const template = z.string().trim().min(1).max(100).parse(input.template);
      const record = z.string().trim().min(1).max(160).parse(input.record);
      const tpl = await pool.query(
        `SELECT id,name,target FROM document_templates WHERE organization_id=$1 AND archived_at IS NULL
        AND (id::text=$2 OR lower(name)=lower($2))`,
        [organization, template],
      );
      if (!tpl.rows[0])
        throw new ToolError(
          "No such template. Call list_document_templates for the names.",
        );
      const target = tpl.rows[0].target as Target;
      if (!targets.includes(target))
        throw new ToolError("Unsupported template.");
      let targetId: string | undefined;
      if (target === "load") {
        const r = await pool.query(
          "SELECT id FROM loads WHERE carrier_id=ANY($1::uuid[]) AND lower(reference)=lower($2) LIMIT 3",
          [[...ids], record],
        );
        if (r.rowCount! > 1)
          throw new ToolError(
            "More than one load has that reference; ask which carrier.",
          );
        targetId = r.rows[0]?.id;
      } else if (target === "carrier") {
        const r = await pool.query(
          "SELECT id FROM carriers WHERE id=ANY($1::uuid[]) AND (id::text=$2 OR lower(name)=lower($2)) LIMIT 3",
          [[...ids], record],
        );
        if (r.rowCount! > 1)
          throw new ToolError("More than one carrier matches.");
        targetId = r.rows[0]?.id;
      } else {
        const r = await pool.query(
          "SELECT id FROM contacts WHERE organization_id=$1 AND (id::text=$2 OR lower(name)=lower($2)) LIMIT 3",
          [organization, record],
        );
        if (r.rowCount! > 1)
          throw new ToolError(
            "More than one contact has that name; ask for the company.",
          );
        targetId = r.rows[0]?.id;
      }
      if (!targetId)
        throw new ToolError(
          `No ${target} matches "${record}" (this template fills from a ${target}).`,
        );
      // The same request in the same minute is the same draft, so a retried
      // step cannot create two.
      const h = createHash("sha256")
        .update(
          `${user}|${tpl.rows[0].id}|${targetId}|${new Date().toISOString().slice(0, 16)}`,
        )
        .digest("hex");
      // Shaped like a version-4 UUID so it passes the same validation as any key.
      const key = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
      let result;
      try {
        result = await generateDraft(
          user,
          {
            template_id: tpl.rows[0].id,
            target_id: targetId,
            idempotency_key: key,
          },
          "assistant",
          organization,
        );
      } catch (e) {
        throw new ToolError(
          e instanceof Error ? e.message : "Could not draft.",
        );
      }
      return {
        data: {
          status: "draft saved for review; nothing was sent",
          template: tpl.rows[0].name,
          for: record,
          missing_fields: result.missing,
        },
        sources: [
          {
            kind: "document" as const,
            id: result.id,
            label: `Draft: ${tpl.rows[0].name} · ${record}`,
          },
        ],
      };
    }
    case "list_carriers": {
      const { rows } = await pool.query(
        `SELECT c.id,c.name,p.contact_name,p.contact_email,p.phone,
          EXISTS(SELECT 1 FROM carrier_dispatch_authorizations a WHERE a.carrier_id=c.id AND a.verified_at IS NOT NULL
            AND a.effective_at<=now() AND a.expires_at>now()) AS agreement_current
        FROM carriers c LEFT JOIN carrier_profiles p ON p.carrier_id=c.id WHERE c.id=ANY($1::uuid[]) ORDER BY c.name LIMIT 50`,
        [[...ids]],
      );
      return {
        data: {
          carriers: rows.map((r) => ({
            id: r.id,
            name: r.name,
            verified_dispatch_agreement_current: r.agreement_current,
            contact: r.contact_name
              ? `${r.contact_name} ${r.contact_email ?? ""} ${r.phone ?? ""}`.trim()
              : null,
          })),
        },
        sources: rows.map((r) => ({
          kind: "carrier" as const,
          id: r.id as string,
          label: r.name as string,
        })),
      };
    }
  }
  throw new ToolError(`Unknown tool ${name}.`);
}

/** A problem the model can read and recover from (not a server error). */
export class ToolError extends Error {}
