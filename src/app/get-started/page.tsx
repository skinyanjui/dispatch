import type { Metadata } from "next";
import Link from "next/link";
import { Cta, MarketingShell } from "@/components/marketing";

export const metadata: Metadata = {
  title: "Get started · Relay",
  description: "What happens after you request access, and what to have ready.",
};

const steps = [
  {
    title: "Request access",
    text: "Tell us who you are and which dispatch company you run. Sending the form creates nothing and sends no email.",
    link: { href: "/request-access", label: "Open the request form" },
  },
  {
    title: "A person reviews it",
    text: "Every request is looked at by a person. If it is approved, your organization is set up with you as its owner.",
  },
  {
    title: "Set your password",
    text: "You receive a private, single-use link to choose your password. No password is ever sent to you. Turn on two-step verification in your account when you are in.",
  },
  {
    title: "Add your carriers",
    text: "Add each carrier you dispatch for and record its written dispatch agreement. Loads can be booked only once the agreement is verified.",
  },
  {
    title: "Invite your team and drivers",
    text: "Invite staff and each carrier's manager and drivers. People see only the carriers they are given.",
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

const faq = [
  [
    "Can I sign up without approval?",
    "No. Relay is invitation-only. Requesting access, or signing in with Google or Apple where they are offered, records a request for a person to review.",
  ],
  [
    "Does it cost anything?",
    "There is no pricing yet. Relay is early software, so nothing is billed.",
  ],
  [
    "Is my freight data live?",
    "No. Today Relay runs with sample data and has no live connections to carriers, load boards or tracking providers.",
  ],
  [
    "Who can see my carriers' information?",
    "Only people you give access to that carrier. Each carrier's data is kept separate.",
  ],
];

export default function GetStarted() {
  return (
    <MarketingShell current="/get-started">
      <section className="mkHero compact">
        <p className="mkEyebrow">Get started</p>
        <h1>From request to first load</h1>
        <p className="mkLead">
          Six steps. Only the first is yours to start; the rest follow once you
          are approved.
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
              {s.link && <Link href={s.link.href}>{s.link.label}</Link>}
            </div>
          </li>
        ))}
      </ol>
      <section className="mkSection mkSplit" aria-labelledby="ready">
        <div>
          <h2 id="ready">Have these ready</h2>
          <p>You can start without them, but setup is quicker with them.</p>
        </div>
        <ul className="mkChecks">
          {ready.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
      <section className="mkSection" aria-labelledby="faq">
        <h2 id="faq">Common questions</h2>
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
        title="Ready when you are"
        text="Send a request, or look around the demo first."
      />
    </MarketingShell>
  );
}
