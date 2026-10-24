// Merge fields for document templates (ADR 0040). Kept free of server imports so
// the interactive demo and the browser can use the same list as the server.
export const targets = ["load", "carrier", "contact"] as const;
export type Target = (typeof targets)[number];

export const mergeFields: Record<Target, Record<string, string>> = {
  load: {
    "load.reference": "Load reference",
    "load.carrier": "Carrier name",
    "load.stage": "Stage",
    "load.rate": "Agreed rate",
    "load.pickup": "Pickup address",
    "load.delivery": "Delivery address",
    "load.next_appointment": "Next appointment",
    "load.driver": "Assigned driver",
  },
  carrier: {
    "carrier.name": "Carrier name",
    "carrier.contact": "Contact name",
    "carrier.email": "Contact email",
    "carrier.phone": "Phone",
  },
  contact: {
    "contact.name": "Contact name",
    "contact.company": "Company",
    "contact.email": "Email",
    "contact.phone": "Phone",
  },
};
const common: Record<string, string> = {
  "sender.name": "Your name",
  today: "Today's date",
};
export const allFields = (t: Target) => ({ ...mergeFields[t], ...common });
