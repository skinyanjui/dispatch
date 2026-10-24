import {
  LightningIcon,
  ReceiptIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Brand } from "@/components/workspace-shell";

/** The left column of the sign-in and invitation screens. */
export function LoginHero() {
  return (
    <aside className="loginHero" aria-label="About Relay">
      <Link href="/welcome" aria-label="Relay home">
        <Brand />
      </Link>
      <div className="heroBody">
        <h2>
          Everything in motion.
          <br />
          All in one place.
        </h2>
        <p className="heroLead">
          Book freight, record every step and bill separately for your carriers,
          with each carrier&apos;s data kept apart.
        </p>
        <ul>
          <li>
            <LightningIcon size={20} weight="fill" aria-hidden="true" />
            See what needs you at a glance
          </li>
          <li>
            <ShieldCheckIcon size={20} weight="fill" aria-hidden="true" />
            Every carrier&apos;s data stays separate
          </li>
          <li>
            <ReceiptIcon size={20} weight="fill" aria-hidden="true" />
            Carrier freight and your fees, tracked apart
          </li>
        </ul>
      </div>
      <p className="heroNote">
        Fictional QA data. No live freight connections.
      </p>
    </aside>
  );
}
