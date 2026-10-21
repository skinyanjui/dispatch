import { LoginHero } from "@/components/login-hero";

/**
 * Sign-in, invitation and password screens share one two-column layout: the
 * hero on the left, a pale column with a floating card on the right.
 */
export function AuthLayout({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <main className={"login authPage " + className}>
      <LoginHero />
      <div className="authSide">
        <p className="authTop">Invitation-only workspace</p>
        <div className="authCard">{children}</div>
      </div>
    </main>
  );
}
