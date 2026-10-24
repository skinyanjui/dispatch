import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import { Brand } from "@/components/workspace-shell";
import { Breadcrumb, type Crumb } from "@/components/ui/breadcrumb";

const nav = [
  { href: "/welcome", label: "Product" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/get-started", label: "Get started" },
  { href: "/pricing", label: "Pricing" },
];

/** Shared frame for the public pages: header, content, footer. */
export function MarketingShell({
  current,
  crumbs,
  children,
}: {
  current: string;
  /** Ancestors then the current page; omitted on the product home page. */
  crumbs?: Crumb[];
  children: ReactNode;
}) {
  return (
    <div className="mk">
      <a className="mkSkip" href="#content">
        Skip to content
      </a>
      <div className="mkBar">
        <header className="mkHeader">
          <Link href="/welcome" aria-label="Relay home">
            <Brand />
          </Link>
          <nav aria-label="Main">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.href === current ? "page" : undefined}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="mkActions">
            <Link href="/">Sign in</Link>
            <Link className="mkButton" href="/request-access">
              Request access
            </Link>
          </div>
        </header>
      </div>
      <main id="content">
        {crumbs && (
          <div className="mkCrumbs">
            <Breadcrumb crumbs={crumbs} />
          </div>
        )}
        {children}
      </main>
      <footer className="mkFooter">
        <div>
          <Brand />
          <p>Dispatch operations for non-asset freight teams.</p>
        </div>
        <nav aria-label="Footer">
          <Link href="/demo">Interactive demo</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </footer>
    </div>
  );
}

export function Cta({ title, text }: { title: string; text?: string }) {
  return (
    <section className="mkCta">
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      <div className="mkRow">
        <Link className="mkButton" href="/request-access">
          Request access
          <ArrowRightIcon size={16} aria-hidden="true" />
        </Link>
        <Link className="mkGhost" href="/demo">
          Try the interactive demo
        </Link>
      </div>
    </section>
  );
}
