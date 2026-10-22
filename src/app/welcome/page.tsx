import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  ChartBarIcon,
  FileTextIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TruckIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { Cta, MarketingShell } from "@/components/marketing";
import { ProductPreview } from "@/components/product-preview";
import { ListItem, ListItems } from "@/components/ui/list-item";

export const metadata: Metadata = {
  title: "Relay · Dispatch operations for carrier agents",
  description:
    "Book, track and bill freight for your carriers in one place, with every carrier's data kept separate.",
};

const cards = [
  {
    icon: TruckIcon,
    title: "Book and dispatch",
    text: "One board for every load, with stops, a driver on each and a record of every step.",
  },
  {
    icon: WarningCircleIcon,
    title: "Track and resolve",
    text: "Check-ins show their source and time. Exceptions get an owner and a trail to resolution.",
  },
  {
    icon: ReceiptIcon,
    title: "Bill, separately",
    text: "What a carrier bills the broker and what you bill the carrier are two records, never one.",
  },
];

export default function Welcome() {
  return (
    <MarketingShell current="/welcome">
      <section className="mkHero mkCenter">
        <p className="mkEyebrow">For dispatch companies working for carriers</p>
        <h1>Everything in motion. All in one place.</h1>
        <p className="mkLead">
          Book, track and bill freight for your carriers, with each
          carrier&apos;s data kept separate.
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

      <section className="mkWide" aria-label="The workspace">
        <ProductPreview />
      </section>

      <section className="mkSection" aria-labelledby="three">
        <h2 id="three" className="srOnly">
          What Relay covers
        </h2>
        <div className="mkGrid">
          {cards.map(({ icon: Icon, title, text }) => (
            <article key={title} className="mkCard">
              <Icon size={22} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mkFeature" aria-labelledby="views">
        <div>
          <p className="mkEyebrow">Views</p>
          <h2 id="views">Look at your loads the way you work</h2>
          <p>
            Switch between board, table and calendar, then save the result as a
            view for yourself or your whole organization.
          </p>
        </div>
        <ListItems label="Views">
          <ListItem
            start={<TruckIcon size={18} />}
            description="Drag a card one step; the rules still apply."
          >
            Board
          </ListItem>
          <ListItem
            start={<ChartBarIcon size={18} />}
            description="Sort, group by stage or carrier, show totals."
          >
            Table
          </ListItem>
          <ListItem
            start={<FileTextIcon size={18} />}
            description="Appointments across the month."
          >
            Calendar
          </ListItem>
        </ListItems>
      </section>

      <section className="mkFeature flip" aria-labelledby="assist">
        <div>
          <p className="mkEyebrow">Documents and the assistant</p>
          <h2 id="assist">Drafts in seconds, reviewed by a person</h2>
          <p>
            Write a template once, fill it from a load, carrier or contact, or
            ask the assistant. Nothing is sent, booked or invoiced for you.
          </p>
        </div>
        <ListItems label="Assistant">
          <ListItem
            start={<SparkleIcon size={18} />}
            description="Optional, off by default, with a monthly limit."
          >
            Ask about your records
          </ListItem>
          <ListItem
            start={<FileTextIcon size={18} />}
            description="Missing values are flagged, not guessed."
          >
            Draft from a template
          </ListItem>
        </ListItems>
      </section>

      <section className="mkFeature" aria-labelledby="rules">
        <div>
          <p className="mkEyebrow">Guardrails</p>
          <h2 id="rules">Boundaries enforced in the product</h2>
          <p>
            Relay enforces the limits of dispatching other people&apos;s
            freight.
          </p>
        </div>
        <ListItems label="Guardrails">
          <ListItem
            start={<ShieldCheckIcon size={18} />}
            description="Booked freight is never moved to another carrier."
          >
            A verified agreement before any booking
          </ListItem>
          <ListItem
            start={<ShieldCheckIcon size={18} />}
            description="Source and time are always shown."
          >
            Tracking is never presented as live
          </ListItem>
          <ListItem
            start={<ShieldCheckIcon size={18} />}
            description="Every important change is written down."
          >
            An audit log
          </ListItem>
        </ListItems>
      </section>

      <section className="mkBand" aria-labelledby="status">
        <h2 id="status">Where Relay is today</h2>
        <p>
          Early software with fictional sample data and access by approval. No
          live connections to carriers, load boards, tracking or payment
          systems, and it does not move money.
        </p>
      </section>

      <Cta title="Try it with sample data" />
    </MarketingShell>
  );
}
