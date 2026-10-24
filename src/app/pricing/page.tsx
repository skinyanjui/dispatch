import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing";
import { MiniAiSwitch, MiniNote } from "@/components/mini-demos";
import { PricingCard, type PricingGroup } from "@/components/ui/pricing-card";

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
      "Optional AI reading and assistant",
      "Every carrier kept separate, with an audit log",
    ],
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
        <div className="pricingMini">
          <MiniAiSwitch />
          <MiniNote />
        </div>
      </section>
    </MarketingShell>
  );
}
