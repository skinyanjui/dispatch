// Client-safe contact vocabulary.
export const contactKinds = [
  "broker",
  "shipper",
  "receiver",
  "facility",
  "vendor",
  "other",
] as const;
export type ContactKind = (typeof contactKinds)[number];
export const contactKindLabels: Record<ContactKind, string> = {
  broker: "Broker",
  shipper: "Shipper",
  receiver: "Receiver",
  facility: "Facility",
  vendor: "Vendor",
  other: "Other",
};
export type DirectoryGroup = "team" | "driver" | "carrier" | "external";
export const groupLabels: Record<DirectoryGroup, string> = {
  team: "Team",
  driver: "Drivers",
  carrier: "Carriers",
  external: "Brokers, shippers and others",
};
export type DirectoryEntry = {
  /** Stable reference: user:<id>, driver:<id>, carrier:<id> or contact:<id>. */
  key: string;
  group: DirectoryGroup;
  name: string;
  /** Role, company or contact kind. */
  detail: string;
  carriers: { id: string; name: string }[];
  email: string;
  phone: string;
  notes?: string;
  favorite: boolean;
  /** External contacts only. */
  contact?: {
    id: string;
    kind: ContactKind;
    company: string;
    carrier_id: string | null;
    version: number;
    editable: boolean;
  };
};
/** Keeps dialable characters only, for tel: and sms: links. */
export const dialable = (phone: string) => phone.replace(/[^\d+]/g, "");
