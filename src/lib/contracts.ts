export const stages = [
  "booked",
  "dispatched",
  "picked-up",
  "delivered",
] as const;
export type Stage = (typeof stages)[number];
export const stageLabels: Record<Stage, string> = {
  booked: "Booked",
  dispatched: "Dispatched",
  "picked-up": "In transit",
  delivered: "Delivered",
};
export type Load = {
  id: string;
  reference: string;
  carrier_id: string;
  carrier_name?: string;
  stage: Stage;
  amount_minor: string;
  pickup: string;
  delivery: string;
  version: number;
  created_at: string;
  source: string;
  stops?: {
    kind: string;
    address: string;
    window_start: string;
    window_end: string;
    timezone: string;
  }[];
  events?: { id: string; type: string; created_at: string }[];
  assignment?: { name: string; driver_id: string } | null;
};
export type Context = {
  user: { name: string };
  carriers: { id: string; name: string; role: string }[];
  drivers: { id: string; name: string; carrier_id: string }[];
};
export type Queue = { loads: Load[]; nextCursor: string | null };
