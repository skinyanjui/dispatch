import {
  LightningIcon,
  ReceiptIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react/dist/ssr";

/** The second column of the sign-in and invitation screens. */
export function LoginHero() {
  return (
    <aside className="loginHero" aria-label="About Relay">
      <div className="heroInner">
        <p className="heroEyebrow">Relay for dispatch teams</p>
        <h2>Know what needs you before you ask.</h2>
        <ul>
          <li>
            <LightningIcon size={22} weight="fill" aria-hidden="true" />
            <span>
              <strong>One board, real answers</strong>
              Next appointment, driver, paperwork and what to do next, on every
              load.
            </span>
          </li>
          <li>
            <ShieldCheckIcon size={22} weight="fill" aria-hidden="true" />
            <span>
              <strong>Carrier data stays separate</strong>
              Every carrier sees only its own loads, documents and billing.
            </span>
          </li>
          <li>
            <ReceiptIcon size={22} weight="fill" aria-hidden="true" />
            <span>
              <strong>Billing that matches reality</strong>
              Carrier freight and your dispatch invoices are tracked apart.
            </span>
          </li>
        </ul>
      </div>
    </aside>
  );
}
