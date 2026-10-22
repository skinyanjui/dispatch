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
    "Will I be charged?",
    "No. Nothing is billed during early access, and Relay does not take payment details.",
  ],
  [
    "What will pricing look like?",
    "It has not been decided. Plans and prices will be published on this page before any charge, and existing organizations will get notice first.",
  ],
  [
    "Does AI cost extra?",
    "AI features are off until an owner or admin turns them on, and they have a monthly limit you set. Model usage is billed to the server operator's own account, not through Relay.",
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
        <h1>Free while Relay is in early access</h1>
        <p className="mkLead">
          There are no plans or prices yet. When there are, they will be here
          first.
        </p>
      </section>
      <section className="mkPlan" aria-labelledby="plan">
        <h2 id="plan">Early access</h2>
        <p className="mkPlanPrice">No charge</p>
        <p className="mkNote">For dispatch companies approved for access.</p>
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
      <Cta
        title="Start with a request"
        text="Approval is by a person. The demo needs no account."
      />
    </MarketingShell>
  );
}
