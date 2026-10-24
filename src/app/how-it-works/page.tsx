import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing";
import type { ReactNode } from "react";
import {
  MiniNote,
  MiniAssign,
  MiniBilling,
  MiniCheckIn,
} from "@/components/mini-demos";
import {
  AuthorizeVisual,
  CreateVisual,
  PaperworkVisual,
} from "@/components/step-visuals";

export const metadata: Metadata = {
  title: "How Relay works · Relay",
  description:
    "From a rate confirmation to a paid dispatch invoice, step by step.",
};

const steps: { id: string; title: string; text: string; show: ReactNode }[] = [
  {
    id: "authorize",
    title: "Authorize the carrier",
    text: "No booking without a verified, current dispatch agreement.",
    show: <AuthorizeVisual />,
  },
  {
    id: "create",
    title: "Create the load",
    text: "By hand, or from a rate confirmation that a person checks.",
    show: <CreateVisual />,
  },
  {
    id: "assign",
    title: "Assign a driver and dispatch",
    text: "Only that carrier's drivers, with a record of who dispatched.",
    show: <MiniAssign bare />,
  },
  {
    id: "follow",
    title: "Follow it to delivery",
    text: "Check-ins keep their source and the time they were observed.",
    show: <MiniCheckIn bare />,
  },
  {
    id: "paperwork",
    title: "Collect the paperwork",
    text: "Scanned, versioned, and shown per load.",
    show: <PaperworkVisual />,
  },
  {
    id: "billing",
    title: "Bill, separately",
    text: "The carrier's packet and your invoice never share a status.",
    show: <MiniBilling bare />,
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
        <ol className="stepShow" aria-label="Steps">
          {steps.map((step, i) => (
            <li key={step.title} id={step.id}>
              <div className="stepText">
                <span className="mkNum">{i + 1}</span>
                <h2>{step.title}</h2>
                <p>{step.text}</p>
              </div>
              <div className="stepMedia">{step.show}</div>
            </li>
          ))}
        </ol>
        <MiniNote />
      </section>
      <section className="mkBand" id="limits">
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
