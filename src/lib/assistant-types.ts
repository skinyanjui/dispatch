// Client-safe assistant wire types (ADR 0031).
export type SourceKind =
  | "load"
  | "prospect"
  | "contact"
  | "carrier"
  | "invoice"
  | "exception";
/** A record a tool actually returned. Built by the server, never by the model. */
export type Source = { kind: SourceKind; id: string; label: string };
export type AssistantTurn = {
  id: string;
  question: string;
  answer: string | null;
  status: "running" | "succeeded" | "failed";
  error_code: string | null;
  sources: Source[];
  provider: string;
  model: string;
  created_at: string;
};
export type AssistantState = {
  /** A provider is configured on this deployment. */
  available: boolean;
  /** An organization owner or admin turned the assistant on. */
  enabled: boolean;
  organization_id: string;
  provider: { name: string; model: string } | null;
  conversations: { id: string; title: string; updated_at: string }[];
};
export type Conversation = {
  id: string;
  title: string;
  turns: AssistantTurn[];
};
export const examplePrompts = [
  "What needs my attention right now?",
  "Which loads have no driver?",
  "Which prospects need a follow-up?",
  "What invoices are overdue?",
];
