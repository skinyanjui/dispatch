import type { Metadata } from "next";
import Link from "next/link";
import { SparkleIcon } from "@phosphor-icons/react/dist/ssr";
import { MarketingShell } from "@/components/marketing";
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
    icon: <SparkleIcon size={18} />,
    title: "AI costs are yours, and off until you turn it on",
    text: "Owners and admins decide whether it runs, with a monthly limit they set. Model usage is billed to your own account, not through Relay.",
  },
];

export default function Pricing() {
  return (
    <MarketingShell
      current="/pricing"
      crumbs={[{ label: "Product", href: "/welcome" }, { label: "Pricing" }]}
    >
      <section className="mkHero mkCenter">
        <h1>Free during early access</h1>
        <p className="mkLead">
          Prices will be published here before any charge.
        </p>
      </section>
      <section aria-label="Plan">
        <PricingCard
          id="plan"
          name="Early access"
          price="Free"
          description="For approved dispatch companies."
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
    </MarketingShell>
  );
}
