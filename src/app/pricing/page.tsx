import type { Metadata } from "next";
import Link from "next/link";
import { Cta, MarketingShell } from "@/components/marketing";
import { ListItem, ListItems } from "@/components/ui/list-item";

export const metadata: Metadata = {
  title: "Pricing · Relay",
  description: "Relay is in early access and has no charges yet.",
};

const included = [
  "Loads, stops, milestones and driver assignment",
  "Documents with scanning and versioning",
  "Exceptions, messaging and contacts",
  "Carrier and dispatch billing records",
  "Optional AI reading and assistant, off by default",
  "Every carrier kept separate, with an audit log",
];

const faq = [
  [
    "What will pricing look like?",
    "Not decided. Existing organizations get notice before any charge.",
  ],
  [
    "Does AI cost extra?",
    "AI features are off until an owner or admin turns them on, and they have a monthly limit you set. Model usage is billed to the operator's own account, not through Relay.",
  ],
];

export default function Pricing() {
  return (
    <MarketingShell
      current="/pricing"
      crumbs={[{ label: "Product", href: "/welcome" }, { label: "Pricing" }]}
    >
      <section className="mkHero mkCenter">
        <p className="mkEyebrow">Pricing</p>
        <h1>Free during early access</h1>
        <p className="mkLead">
          Prices will be published here before any charge.
        </p>
      </section>
      <section className="mkPlan" aria-labelledby="plan">
        <h2 id="plan">Early access</h2>
        <p className="mkPlanPrice">Free</p>
        <p className="mkNote">
          For approved dispatch companies. No payment details taken.
        </p>
        <Link className="mkButton" href="/request-access">
          Request access
        </Link>
        <ListItems label="Included">
          {included.map((i) => (
            <ListItem key={i}>{i}</ListItem>
          ))}
        </ListItems>
      </section>
      <section className="mkSection" aria-labelledby="faq">
        <h2 id="faq">Questions</h2>
        <div className="mkFaq">
          {faq.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <Cta title="Start with a request" />
    </MarketingShell>
  );
}
