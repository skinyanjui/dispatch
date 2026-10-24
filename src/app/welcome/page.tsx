import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import { MarketingShell } from "@/components/marketing";
import {
  MiniAssign,
  MiniBilling,
  MiniCheckIn,
  MiniDraft,
  MiniNote,
} from "@/components/mini-demos";
import { ProductPreview } from "@/components/product-preview";

export const metadata: Metadata = {
  title: "Relay · Dispatch operations for carrier agents",
  description:
    "Book freight, record every step and bill separately for your carriers, with every carrier's data kept apart.",
};

export default function Welcome() {
  return (
    <MarketingShell current="/welcome">
      <section className="mkHero mkCenter">
        <p className="mkEyebrow">For dispatch companies working for carriers</p>
        <h1>Everything in motion. All in one place.</h1>
        <p className="mkLead">
          Book freight, record every step and bill separately for your carriers,
          with each carrier&apos;s data kept apart.
        </p>
        <div className="mkRow mkRowCenter">
          <Link className="mkButton" href="/request-access">
            Request access
            <ArrowRightIcon size={16} aria-hidden="true" />
          </Link>
          <Link className="mkGhost" href="/demo">
            Try the interactive demo
          </Link>
        </div>
      </section>

      <section className="mkWide" id="board" aria-label="The workspace">
        <ProductPreview />
      </section>

      <section className="mkSection" aria-labelledby="three">
        <h2 id="three" className="srOnly">
          Try it
        </h2>
        <div className="mkMiniGrid">
          <div id="assign">
            <MiniAssign />
          </div>
          <div id="checkin">
            <MiniCheckIn />
          </div>
          <div id="billing">
            <MiniBilling />
          </div>
        </div>
      </section>

      <MiniNote wide />

      <section className="mkFeature" id="drafts" aria-labelledby="assist">
        <MiniDraft />
        <div>
          <h2 id="assist">Drafts in seconds, reviewed by a person</h2>
          <p>
            Fill a template from a load, carrier or contact, or ask the
            assistant. Nothing is sent, booked or invoiced for you.
          </p>
        </div>
      </section>

      <section className="mkBand" aria-labelledby="status">
        <h2 id="status">Where Relay is today</h2>
        <p>
          Early software, with access by approval. No live connections to
          carriers, load boards, tracking or payment systems, and it does not
          move money.
        </p>
      </section>
    </MarketingShell>
  );
}
