import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing";
import { legalUpdated, legalVersion } from "@/lib/legal";

/**
 * Shared frame for the Terms and Privacy pages: the same top bar, breadcrumb
 * and footer as the rest of the site, the text in a readable column, and an
 * "On this page" list (sticky beside the text on wide screens, a row of links
 * on phones).
 */
export function LegalPage({
  title,
  sections,
  children,
}: {
  title: string;
  sections: { id: string; title: string }[];
  children: ReactNode;
}) {
  const path = title === "Privacy" ? "/privacy" : "/terms";
  return (
    <MarketingShell
      current={path}
      crumbs={[{ label: "Product", href: "/welcome" }, { label: title }]}
    >
      <section className="legalLayout">
        <nav className="legalToc" aria-label="On this page">
          <p>On this page</p>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={"#" + s.id}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="legalDoc">
          <p className="legalDraft" role="note">
            <strong>Draft, not reviewed by a lawyer.</strong> This page
            describes how Relay works today in plain language. It has not been
            through legal review and should be before real customers rely on
            it. Items in [brackets] still need to be filled in by the operator.
          </p>
          <h1>{title}</h1>
          <p className="legalMeta">
            Version {legalVersion} · Updated {legalUpdated}
          </p>
          {children}
          <p className="legalBack">
            <Link href="/">Back to sign in</Link>
          </p>
        </article>
      </section>
    </MarketingShell>
  );
}
