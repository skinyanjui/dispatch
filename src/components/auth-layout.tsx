import { LoginHero } from "@/components/login-hero";

/**
 * Sign-in, invitation and password screens share one two-column layout: the
 * hero on the left, a pale column with a floating card on the right.
 */
export function AuthLayout({
  children,
  className = "",
  topRight,
}: {
  children: React.ReactNode;
  className?: string;
  /** Replaces the note at the top right of the page. */
  topRight?: React.ReactNode;
}) {
  return (
    <main className={"login authPage " + className}>
      <LoginHero />
      <div className="authSide">
        <p className="authTop">{topRight ?? "Invitation-only workspace"}</p>
        <div className="authCard">{children}</div>
      </div>
    </main>
  );
}
