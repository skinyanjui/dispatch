import type { ReactNode } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/ssr";

export type PricingGroup = { title: string; items: string[] };

/**
 * One plan: what it is and costs on the left, what it includes on the right
 * (stacked on phones). The price is plain text the caller supplies, so a plan
 * with no published price says "Free" or "To be announced", never a made-up
 * figure. `action` is the plan's one button or link.
 */
export function PricingCard({
  id,
  name,
  badge,
  price,
  priceNote,
  description,
  action,
  footnote,
  includesLabel,
  groups,
}: {
  id: string;
  name: string;
  badge?: string;
  price: string;
  priceNote?: string;
  description: string;
  action: ReactNode;
  footnote?: string;
  includesLabel: string;
  groups: PricingGroup[];
}) {
  return (
    <article className="pricingCard" aria-labelledby={id}>
      <div className="pricingMain">
        <div className="pricingHead">
          <h2 id={id}>{name}</h2>
          {badge && <span className="pricingBadge">{badge}</span>}
        </div>
        <p className="pricingPrice">
          <span className="pricingAmount">{price}</span>
          {priceNote && <span className="pricingUnit">{priceNote}</span>}
        </p>
        <p className="pricingDesc">{description}</p>
        {action}
        {footnote && <p className="pricingFoot">{footnote}</p>}
      </div>
      <div className="pricingIncludes">
        <h3>{includesLabel}</h3>
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h4>{g.title}</h4>
            <ul>
              {g.items.map((item) => (
                <li key={item}>
                  <CheckCircleIcon size={18} weight="fill" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}

/** Short assurances under a plan card: an icon, a title and one line each. */
export function PricingAssurances({
  items,
}: {
  items: { icon: ReactNode; title: string; text: string }[];
}) {
  return (
    <ul className="pricingAssurances">
      {items.map((i) => (
        <li key={i.title}>
          <span className="pricingAssuranceIcon" aria-hidden="true">
            {i.icon}
          </span>
          <strong>{i.title}</strong>
          <span>{i.text}</span>
        </li>
      ))}
    </ul>
  );
}
