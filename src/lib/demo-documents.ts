import { render } from "./draft-render";
import { allFields, type Target } from "./draft-fields";

// Templates and drafts for the interactive demo and the home-page preview
// (ADR 0040). Drafts are filled with the same plain lookup the server uses
// (`render`), from the demo's own sample loads. Everything is fictional and
// stays in the browser.
export type DemoTemplate = {
  id: string;
  name: string;
  target: Target;
  body: string;
  version: number;
};
export type DemoDraft = {
  id: string;
  template_name: string;
  target: Target;
  target_label: string;
  body: string;
  missing: string[];
  source: "person" | "assistant";
  status: "draft" | "approved" | "discarded";
  created_at: string;
  created_by_name: string;
};
export type DemoDocuments = {
  templates: DemoTemplate[];
  drafts: DemoDraft[];
};
type SampleLoad = {
  reference: string;
  carrier_name?: string;
  stage: string;
  pickup: string;
  delivery: string;
  amount_minor: string;
  assignment?: { name: string } | null;
};

const stageNames: Record<string, string> = {
  booked: "Booked",
  dispatched: "Dispatched",
  "picked-up": "In transit",
  delivered: "Delivered",
};
const templates: Omit<DemoTemplate, "id">[] = [
  {
    name: "Check call",
    target: "load",
    version: 1,
    body: "Hi {{load.driver}}, checking on {{load.reference}} for {{load.carrier}}. Is the pickup at {{load.pickup}} on track for {{load.next_appointment}}? — {{sender.name}}",
  },
  {
    name: "Broker update",
    target: "load",
    version: 1,
    body: "Update on {{load.reference}}: {{load.stage}}, {{load.pickup}} to {{load.delivery}}. — {{sender.name}}",
  },
  {
    name: "Carrier welcome",
    target: "carrier",
    version: 1,
    body: "Welcome, {{carrier.contact}}. {{carrier.name}} is set up in Relay. — {{sender.name}}",
  },
];

/** Fills a template from a sample load with the server's own plain lookup. */
export function fillFromLoad(load: SampleLoad, body: string) {
  return render(body, {
    "load.reference": load.reference,
    "load.carrier": load.carrier_name ?? "",
    "load.driver": load.assignment?.name ?? "",
    "load.stage": stageNames[load.stage] ?? load.stage,
    "load.pickup": load.pickup,
    "load.delivery": load.delivery,
    "sender.name": "Alex Morgan",
  });
}
export const demoTemplates = () =>
  templates.map((t, i) => ({
    ...t,
    id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
  }));

export function seedDocuments(loads: SampleLoad[]): DemoDocuments {
  const made = templates.map((t, i) => ({
    ...t,
    id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
  }));
  const minutes = (n: number) => new Date(Date.now() - n * 60000).toISOString();
  const fill = fillFromLoad;
  const drafts: DemoDraft[] = loads.slice(0, 3).map((load, i) => {
    const template = made[i % 2];
    const filled = fill(load, template.body);
    return {
      id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`,
      template_name: template.name,
      target: "load",
      target_label: load.reference,
      body: filled.text,
      missing: filled.missing,
      source: i === 1 ? "assistant" : "person",
      status: i === 2 ? "approved" : "draft",
      created_at: minutes(25 + i * 90),
      created_by_name: "Alex Morgan",
    };
  });
  return { templates: made, drafts };
}

export const templateFields = () => ({
  load: allFields("load"),
  carrier: allFields("carrier"),
  contact: allFields("contact"),
});
