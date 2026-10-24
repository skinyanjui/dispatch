import type { ReactNode } from "react";
import Link from "next/link";
import { Brand } from "@/components/workspace-shell";
import { MarketingNav } from "@/components/marketing-nav";
import { Breadcrumb, type Crumb } from "@/components/ui/breadcrumb";

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
          <Link href="/welcome" aria-label="Relay home" className="mkLogo">
            <Brand />
          </Link>
          <MarketingNav current={current} />
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
          <Link href="/welcome" aria-label="Relay home" className="mkLogo">
            <Brand />
          </Link>
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
