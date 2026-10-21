// Client-safe notification vocabulary.
export const optionalKinds = [
  "assignment",
  "exception_assigned",
  "document_reminder",
  "insurance_reminder",
  "exception_overdue",
] as const;
export type OptionalKind = (typeof optionalKinds)[number];
export type NotificationKind =
  | OptionalKind
  | "invitation"
  | "password_reset"
  | "email_verification";
export const notificationLabels: Record<NotificationKind, string> = {
  invitation: "Invitations",
  password_reset: "Password reset",
  email_verification: "Email verification",
  assignment: "Load assignments (drivers)",
  exception_assigned: "Exceptions assigned to me",
  document_reminder: "Missing POD reminders",
  insurance_reminder: "Insurance expiry reminders",
  exception_overdue: "Overdue exception reminders",
};
export type NotificationLogEntry = {
  id: string;
  kind: NotificationKind;
  recipient_email: string;
  subject: string;
  status: "pending" | "sent" | "failed" | "suppressed";
  attempts: number;
  last_error: string | null;
  provider: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string;
  retryable: boolean;
};
