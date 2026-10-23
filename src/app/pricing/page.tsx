import type { Metadata } from "next";
import Link from "next/link";
import {
  BellRingingIcon,
  CreditCardIcon,
  SparkleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { Cta, MarketingShell } from "@/components/marketing";
import {
  PricingAssurances,
  PricingCard,
  type PricingGroup,
} from "@/components/ui/pricing-card";

export const metadata: Metadata = {
  title: "Pricing · Relay",
  description: "Relay is in early access and has no charges yet.",
};

const groups: PricingGroup[] = [
  {
    title: "Operations",
    items: [
      "Loads, stops, milestones and driver assignment",
      "Exceptions, messaging and contacts",
    ],
  },
  {
    title: "Records and billing",
    items: [
      "Documents with scanning and versioning",
      "Carrier and dispatch billing records",
    ],
  },
  {
    title: "Control",
    items: [
      "Optional AI reading and assistant, off by default",
      "Every carrier kept separate, with an audit log",
    ],
  },
];

const assurances = [
  {
    icon: <CreditCardIcon size={18} />,
    title: "No payment details",
    text: "Nothing to enter or cancel during early access.",
  },
  {
    icon: <BellRingingIcon size={18} />,
    title: "Notice before any charge",
    text: "Existing organizations hear first, and prices are published here.",
  },
  {
    icon: <SparkleIcon size={18} />,
    title: "AI is off until you turn it on",
    text: "Owners and admins decide whether it runs. Model usage is billed to your own account.",
  },
];

const faq = [
  [
    "What will pricing look like?",
    "Not decided. Existing organizations get notice before any charge.",
  ],
  [
    "Who can join?",
    "Approved dispatch companies. Each request is reviewed, and nothing is created until it is approved.",
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
      <section aria-label="Plan">
        <PricingCard
          id="plan"
          name="Early access"
          badge="Open by request"
          price="Free"
          priceNote="while we are in early access"
          description="For approved dispatch companies. Everything below is included."
          action={
            <Link className="mkButton" href="/request-access">
              Request access
            </Link>
          }
          footnote="No payment details taken."
          includesLabel="Everything included"
          groups={groups}
        />
        <PricingAssurances items={assurances} />
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
