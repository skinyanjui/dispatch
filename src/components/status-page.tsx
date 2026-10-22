import { AuthLayout } from "@/components/auth-layout";

/** A full-page message for a missing address or a failed page. */
export function StatusPage({
  code,
  title,
  children,
  actions,
  alert = false,
}: {
  code: string;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  /** Announce the message to screen readers (failures, not missing pages). */
  alert?: boolean;
}) {
  return (
    <AuthLayout topRight="Relay">
      <section
        className="loginPanel statusPage"
        role={alert ? "alert" : undefined}
      >
        <p className="eyebrow">{code}</p>
        <h1>{title}</h1>
        <p className="setupIntro">{children}</p>
        <div className="statusActions">{actions}</div>
      </section>
    </AuthLayout>
  );
}
