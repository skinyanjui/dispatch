import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing";
import { ListItem, ListItems } from "@/components/ui/list-item";

export const metadata: Metadata = {
  title: "How Relay works · Relay",
  description:
    "From a rate confirmation to a paid dispatch invoice, step by step.",
};

const steps = [
  {
    title: "Authorize the carrier",
    text: "Add the carrier and its written dispatch agreement. A load cannot be booked or assigned until the agreement is verified and current.",
  },
  {
    title: "Create the load",
    text: "Enter it by hand, or choose a broker's rate confirmation and let the form be filled in for you to check. The AI suggests; you create the load.",
  },
  {
    title: "Assign a driver and dispatch",
    text: "Pick a driver from that carrier only. Dispatching is a deliberate step with a record of who did it.",
  },
  {
    title: "Follow it to delivery",
    text: "Drivers and staff add check-ins and milestones. Each shows where it came from and when it was observed, so stale information is obvious.",
  },
  {
    title: "Collect the paperwork",
    text: "Documents are scanned and versioned. Each load shows what is received, accepted or missing.",
  },
  {
    title: "Bill, separately",
    text: "The carrier's packet to the broker and your dispatch invoice to the carrier are tracked on their own, so one never hides the other.",
  },
];

export default function HowItWorks() {
  return (
    <MarketingShell
      current="/how-it-works"
      crumbs={[
        { label: "Product", href: "/welcome" },
        { label: "How it works" },
      ]}
    >
      <section className="mkHero compact">
        <h1>From rate confirmation to dispatch invoice</h1>
        <p className="mkLead">
          Six steps, each recorded with who did it.{" "}
          <Link href="/demo">See it in the interactive demo.</Link>
        </p>
      </section>
      <section className="mkSection">
        <ListItems label="Steps" ordered>
          {steps.map((s, i) => (
            <ListItem
              key={s.title}
              start={<span className="mkNum">{i + 1}</span>}
              description={s.text}
            >
              {s.title}
            </ListItem>
          ))}
        </ListItems>
      </section>
      <section className="mkBand">
        <h2>What it does not do</h2>
        <p>
          Relay does not book freight on your behalf, connect to live carriers
          or tracking providers yet, or move or hold money. Invoices and
          payments are records you keep.
        </p>
      </section>
    </MarketingShell>
  );
}
