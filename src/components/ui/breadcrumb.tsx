import Link from "next/link";
import type { ReactNode } from "react";

export type Crumb = { label: ReactNode; href?: string };

/**
 * A trail of ancestor links ending at the current page. The separators are
 * decorative and hidden from assistive technology; the last item is marked as
 * the current page whether or not it links anywhere. Long labels truncate.
 */
export function Breadcrumb({
  crumbs,
  label = "Breadcrumb",
}: {
  crumbs: Crumb[];
  label?: string;
}) {
  return (
    <nav aria-label={label} className="crumbs">
      <ol>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={i}>
              {c.href && !last ? (
                <Link href={c.href}>{c.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined}>{c.label}</span>
              )}
              {!last && (
                <span className="crumbSep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
