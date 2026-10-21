import type { ReactNode } from "react";
import Link from "next/link";
import { Brand } from "@/components/workspace-shell";
import { legalUpdated, legalVersion } from "@/lib/legal";

/** Shared frame for the Terms and Privacy pages. */
export function LegalPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="legalPage">
      <header className="legalHeader">
        <Link href="/" aria-label="Relay home" className="legalBrand">
          <Brand />
        </Link>
        <nav aria-label="Legal pages">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </header>
      <article className="legalBody">
        <p className="legalDraft" role="note">
          <strong>Draft, not reviewed by a lawyer.</strong> This page describes
          how Relay works today in plain language. It has not been through legal
          review and should be before real customers rely on it. Items in
          [brackets] still need to be filled in by the operator.
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
    </main>
  );
}
