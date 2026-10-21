// Browser-only demo of the assistant (ADR 0031): fixed keyword rules over the
// fictional demo data, no AI and no network. It labels itself as sample output.
import type { Load } from "./contracts";
import type { Prospect } from "./prospect-types";
import type { AssistantTurn, Source } from "./assistant-types";

const bullets = (rows: string[]) => rows.map((r) => `• ${r}`).join("\n");

export function demoAnswer(
  question: string,
  loads: Load[],
  prospects: Prospect[],
  today: string,
): { answer: string; sources: Source[] } {
  const q = question.toLowerCase();
  const live = loads.filter((l) => !l.cancelled_at);
  const load = (l: Load): Source => ({
    kind: "load",
    id: l.id,
    label: l.reference,
  });
  const note = "Sample answer from fixed rules, no AI used.";
  const done = (answer: string, sources: Source[] = []) => ({
    answer: `${answer}\n\n${note}`,
    sources,
  });
  const ref = live.find((l) => q.includes(l.reference.toLowerCase()));
  if (ref)
    return done(
      `${ref.reference} (${ref.carrier_name}) is ${ref.stage}. Driver: ${ref.summary?.driver_name ?? "none assigned"}. Next: ${ref.summary?.attention.next_step ?? "see the load"}.`,
      [load(ref)],
    );
  if (/(no|without|missing) driver|unassigned/.test(q)) {
    const rows = live.filter((l) =>
      l.summary?.attention.reasons.some((r) => r.key === "no_driver"),
    );
    return done(
      rows.length
        ? `${rows.length} loads need a driver:\n${bullets(rows.map((l) => `${l.reference} (${l.carrier_name})`))}`
        : "Every active load has a driver.",
      rows.map(load),
    );
  }
  if (/attention|urgent|late|right now|needs me|priority/.test(q)) {
    const rows = live.filter(
      (l) => l.summary && l.summary.attention.level !== "ok",
    );
    return done(
      rows.length
        ? `${rows.length} loads need attention:\n${bullets(rows.map((l) => `${l.reference}: ${l.summary!.attention.reasons.map((r) => r.text).join("; ")}`))}`
        : "Nothing needs attention right now.",
      rows.map(load),
    );
  }
  if (/prospect|lead|follow.?up/.test(q)) {
    const rows = /follow|overdue/.test(q)
      ? prospects.filter(
          (p) => p.next_follow_up_on !== null && p.next_follow_up_on <= today,
        )
      : prospects;
    return done(
      rows.length
        ? `${rows.length} prospects:\n${bullets(rows.map((p) => `${p.company} (${p.stage})${p.next_follow_up_on ? `, follow up ${p.next_follow_up_on}` : ""}`))}`
        : "No prospects match.",
      rows.map((p) => ({
        kind: "prospect" as const,
        id: p.id,
        label: p.company,
      })),
    );
  }
  return done(
    "In this demo I can answer what needs attention, which loads have no driver, which prospects need a follow-up, or look up a load by its reference.",
  );
}

export function demoTurn(
  question: string,
  result: { answer: string; sources: Source[] },
): AssistantTurn {
  return {
    id: crypto.randomUUID(),
    question,
    answer: result.answer,
    status: "succeeded",
    error_code: null,
    sources: result.sources,
    provider: "fixture",
    model: "fixture",
    created_at: new Date().toISOString(),
  };
}
