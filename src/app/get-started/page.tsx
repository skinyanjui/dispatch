import type { Metadata } from "next";
import Link from "next/link";
import { Cta, MarketingShell } from "@/components/marketing";
import { ListItem, ListItems } from "@/components/ui/list-item";

export const metadata: Metadata = {
  title: "Get started · Relay",
  description: "What happens after you request access, and what to have ready.",
};

const steps = [
  {
    title: "Request access",
    text: "Tell us who you are and which dispatch company you run.",
    link: { href: "/request-access", label: "Open the request form" },
  },
  {
    title: "A person reviews it",
    text: "A person reviews every request. If approved, your organization is set up with you as owner.",
  },
  {
    title: "Set your password",
    text: "A private, single-use link lets you choose your password. Then turn on two-step verification.",
  },
  {
    title: "Add your carriers",
    text: "Add each carrier and its written dispatch agreement. Loads can be booked once it is verified.",
  },
  {
    title: "Invite your team and drivers",
    text: "Invite staff, carrier managers and drivers. Each person sees only the carriers they are given.",
  },
  {
    title: "Create your first load",
    text: "Enter a load or start from a rate confirmation, assign a driver, and dispatch.",
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
        <p className="mkEyebrow">Get started</p>
        <h1>From request to first load</h1>
        <p className="mkLead">
          Six steps. Only the first is yours to start.
        </p>
      </section>
      <section className="mkSection">
        <ListItems label="Steps" ordered>
          {steps.map((s, i) => (
            <ListItem
              key={s.title}
              start={<span className="mkNum">{i + 1}</span>}
              description={
                <>
                  {s.text}
                  {s.link && (
                    <>
                      {" "}
                      <Link href={s.link.href}>{s.link.label}</Link>
                    </>
                  )}
                </>
              }
            >
              {s.title}
            </ListItem>
          ))}
        </ListItems>
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
      <Cta title="Ready when you are" />
    </MarketingShell>
  );
}
