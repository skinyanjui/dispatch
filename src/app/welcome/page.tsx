import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  FileTextIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TruckIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { Cta, MarketingShell } from "@/components/marketing";

export const metadata: Metadata = {
  title: "Relay · Dispatch operations for carrier agents",
  description:
    "Book, track and bill freight for your carriers in one place, with every carrier's data kept separate.",
};

const features = [
  {
    icon: TruckIcon,
    title: "Loads from booking to delivery",
    text: "One board for every load, with stops, milestones and a driver on each. Each step is recorded with who did it and when.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Every carrier kept separate",
    text: "A carrier's loads, documents and messages are visible only to the people given access to that carrier. Nothing moves between carriers.",
  },
  {
    icon: FileTextIcon,
    title: "Documents with a paper trail",
    text: "Upload rate confirmations, BOLs and proofs of delivery. Files are scanned, kept as versions and never overwritten.",
  },
  {
    icon: WarningCircleIcon,
    title: "Exceptions with an owner",
    text: "Flag a late pickup or a missing document, give it an owner, and work it to resolution from one queue.",
  },
  {
    icon: ReceiptIcon,
    title: "Two kinds of billing, kept apart",
    text: "What a carrier bills the broker and what you bill the carrier for dispatch are separate records with separate status.",
  },
  {
    icon: SparkleIcon,
    title: "AI that only suggests",
    text: "Optional, off by default. It can read a rate confirmation or answer a question about your records. A person checks and decides.",
  },
];

export default function Welcome() {
  return (
    <MarketingShell current="/welcome">
      <section className="mkHero">
        <p className="mkEyebrow">For dispatch companies working for carriers</p>
        <h1>Everything in motion. All in one place.</h1>
        <p className="mkLead">
          Relay helps dispatch teams book, track and bill freight for their
          carriers without the busywork, and keeps each carrier&apos;s data
          apart.
        </p>
        <div className="mkRow">
          <Link className="mkButton" href="/request-access">
            Request access
            <ArrowRightIcon size={16} aria-hidden="true" />
          </Link>
          <Link className="mkGhost" href="/demo">
            Try the interactive demo
          </Link>
        </div>
        <p className="mkNote">
          Access is by approval. The demo uses fictional data and makes no live
          freight connections.
        </p>
      </section>

      <section className="mkSection" aria-labelledby="what">
        <h2 id="what">What Relay does</h2>
        <div className="mkGrid">
          {features.map(({ icon: Icon, title, text }) => (
            <article key={title} className="mkCard">
              <Icon size={22} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mkSection mkSplit" aria-labelledby="rules">
        <div>
          <h2 id="rules">Guardrails built in</h2>
          <p>
            Dispatching other people&apos;s freight needs clear boundaries.
            Relay enforces them in the product rather than leaving them to
            habit.
          </p>
        </div>
        <ul className="mkChecks">
          <li>
            A carrier needs a verified written dispatch agreement before a load
            can be booked or assigned.
          </li>
          <li>Booked freight is never moved to another carrier.</li>
          <li>Tracking is shown with its source and time, not as live data.</li>
          <li>Every important change is written to an audit log.</li>
          <li>Messages go only to people who agreed to receive them.</li>
        </ul>
      </section>

      <section className="mkBand" aria-labelledby="status">
        <h2 id="status">Where Relay is today</h2>
        <p>
          Relay is early software. It runs with fictional sample data and has no
          live connections to carriers, load boards, tracking providers or
          payment systems, and it does not move money. Read{" "}
          <Link href="/how-it-works">how it works</Link> or{" "}
          <Link href="/get-started">what getting started involves</Link>.
        </p>
      </section>

      <Cta
        title="See it with your own workflow in mind"
        text="Request access and a person will review it, or open the demo to click through a sample workspace."
      />
    </MarketingShell>
  );
}
