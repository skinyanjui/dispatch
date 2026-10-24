import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing";
import type { ReactNode } from "react";
import { ListItem, ListItems } from "@/components/ui/list-item";
import { MiniNote, MiniAssign } from "@/components/mini-demos";
import {
  CarriersVisual,
  InviteVisual,
  PasswordVisual,
  RequestVisual,
  ReviewVisual,
} from "@/components/step-visuals";

export const metadata: Metadata = {
  title: "Get started · Relay",
  description: "What happens after you request access, and what to have ready.",
};

const steps: {
  title: string;
  text: string;
  show: ReactNode;
  link?: { href: string; label: string };
}[] = [
  {
    title: "Request access",
    text: "Tell us who you are and which dispatch company you run.",
    show: <RequestVisual />,
    link: { href: "/request-access", label: "Open the request form" },
  },
  {
    title: "A person reviews it",
    text: "Nothing is created until a person approves it.",
    show: <ReviewVisual />,
  },
  {
    title: "Set your password",
    text: "A private, single-use link, then two-step verification.",
    show: <PasswordVisual />,
  },
  {
    title: "Add your carriers",
    text: "Each carrier and its written agreement.",
    show: <CarriersVisual />,
  },
  {
    title: "Invite your team and drivers",
    text: "Each person sees only the carriers they are given.",
    show: <InviteVisual />,
  },
  {
    title: "Create your first load",
    text: "Assign a driver and dispatch.",
    show: <MiniAssign bare />,
  },
];

const ready = [
  "Your company name and a work email you can receive mail at",
  "The carriers you dispatch for, with contact details",
  "A written dispatch agreement for each carrier",
  "A driver name and email for each carrier, if drivers will report in",
];

export default function GetStarted() {
  return (
    <MarketingShell
      current="/get-started"
      crumbs={[
        { label: "Product", href: "/welcome" },
        { label: "Get started" },
      ]}
    >
      <section className="mkHero compact">
        <h1>From request to first load</h1>
        <p className="mkLead">Six steps. Only the first is yours to start.</p>
      </section>
      <section className="mkSection">
        <ol className="stepShow" aria-label="Steps">
          {steps.map((step, i) => (
            <li key={step.title}>
              <div className="stepText">
                <span className="mkNum">{i + 1}</span>
                <h2>{step.title}</h2>
                <p>
                  {step.text}
                  {step.link && (
                    <>
                      {" "}
                      <Link href={step.link.href}>{step.link.label}</Link>
                    </>
                  )}
                </p>
              </div>
              <div className="stepMedia">{step.show}</div>
            </li>
          ))}
        </ol>
        <MiniNote />
      </section>
      <section className="mkSection mkSplit" aria-labelledby="ready">
        <div>
          <h2 id="ready">Have these ready</h2>
        </div>
        <ListItems label="Have ready">
          {ready.map((r) => (
            <ListItem key={r}>{r}</ListItem>
          ))}
        </ListItems>
      </section>
    </MarketingShell>
  );
}
