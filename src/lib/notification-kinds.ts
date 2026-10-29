// Client-safe notification vocabulary.
export const optionalKinds = [
  "assignment",
  "exception_assigned",
  "document_reminder",
  "insurance_reminder",
  "exception_overdue",
  "message_received",
  "appointment_reminder",
  "approval_request",
  "registration_alert",
] as const;
export type OptionalKind = (typeof optionalKinds)[number];
export type NotificationKind =
  | OptionalKind
  | "invitation"
  | "password_reset"
  | "email_verification"
  | "message";
export const notificationLabels: Record<NotificationKind, string> = {
  invitation: "Invitations",
  password_reset: "Password reset",
  email_verification: "Email verification",
  assignment: "Load assignments (drivers)",
  exception_assigned: "Exceptions assigned to me",
  document_reminder: "Missing POD reminders",
  insurance_reminder: "Insurance expiry reminders",
  exception_overdue: "Overdue exception reminders",
  message_received: "New messages in my inbox",
  appointment_reminder: "Upcoming pickup and delivery reminders (drivers)",
  approval_request: "Changes waiting for my approval",
  registration_alert: "Carrier registration needs attention",
  message: "Messages sent from Relay",
};
export type NotificationLogEntry = {
  id: string;
  kind: NotificationKind;
  recipient_email: string;
  subject: string;
  status: "pending" | "sent" | "delivered" | "failed" | "suppressed";
  attempts: number;
  last_error: string | null;
  provider: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string;
  retryable: boolean;
};
