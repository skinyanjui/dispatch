import type { Metadata } from "next";
import { Cta, MarketingShell } from "@/components/marketing";

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
    <MarketingShell current="/how-it-works">
      <section className="mkHero compact">
        <p className="mkEyebrow">How it works</p>
        <h1>From rate confirmation to dispatch invoice</h1>
        <p className="mkLead">
          Six steps, each with one place to do it and a record of who did.
        </p>
      </section>
      <ol className="mkSteps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <span className="mkNum" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <h2>{s.title}</h2>
              <p>{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <section className="mkBand">
        <h2>What it does not do</h2>
        <p>
          Relay does not book freight on your behalf, connect to live carriers
          or tracking providers yet, or move or hold money. Invoices and
          payments are records you keep.
        </p>
      </section>
      <Cta
        title="Walk through it yourself"
        text="The demo has sample loads, carriers and documents you can click through."
      />
    </MarketingShell>
  );
}
