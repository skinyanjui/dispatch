import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy · Relay" };

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy"
      sections={[
        { id: "what-relay-stores", title: "What Relay stores" },
        { id: "cookies", title: "Cookies" },
        {
          id: "who-else-sees-your-information",
          title: "Who else sees your information",
        },
        { id: "security", title: "Security" },
        {
          id: "keeping-and-deleting-information",
          title: "Keeping and deleting information",
        },
        { id: "contact", title: "Contact" },
      ]}
    >
      <h2 id="what-relay-stores">What Relay stores</h2>
      <ul>
        <li>
          <strong>Accounts:</strong> name, email, optional phone, a password
          stored only as a salted hash, optional two-step verification, and your
          sessions.
        </li>
        <li>
          <strong>Your organization&apos;s records:</strong> carriers and their
          contacts, drivers, loads and stops, appointments and reported
          arrivals, exceptions, messages you log or send, prospects, billing
          records and the audit trail of who changed what.
        </li>
        <li>
          <strong>Documents:</strong> files you upload (for example insurance,
          rate confirmations, bills of lading and proofs of delivery), each
          version kept with who uploaded it, when, its checksum and its malware
          scan result.
        </li>
        <li>
          <strong>Access requests:</strong> the name, email, company and note
          you submit, which version of these pages you saw, and the decision.
        </li>
      </ul>
      <h2 id="cookies">Cookies</h2>
      <p>
        Relay sets one cookie, <code>relay_session</code>, to keep you signed
        in. It is not readable by page scripts and is only sent to Relay. It
        ends when you close the browser, unless you choose to stay signed in, in
        which case it lasts 30 days. Relay uses no advertising or analytics
        cookies.
      </p>
      <h2 id="who-else-sees-your-information">
        Who else sees your information
      </h2>
      <ul>
        <li>
          <strong>Your own organization and its carriers</strong>, according to
          their roles. A carrier cannot see another carrier&apos;s records.
        </li>
        <li>
          <strong>An AI model provider</strong>, only if an owner or admin of
          your organization has turned on an AI feature, and only for the
          request a person makes: the single file being read, or the records the
          assistant looks up to answer a question. Tax forms and dispatch
          agreements are never sent for reading. Each request is recorded with
          its cost.
        </li>
        <li>
          <strong>Email and text providers</strong>, only if the operator has
          configured them, to deliver messages you chose to send. Texts go only
          to people who agreed to receive them.
        </li>
        <li>
          <strong>Hosting and storage</strong> providers that run the database
          and file storage. [List the actual providers and regions: to be
          completed.]
        </li>
        <li>
          <strong>Google or Apple</strong>, only if you choose to sign in with
          them. Relay receives your verified email address and a stable account
          identifier. It does not receive your password.
        </li>
      </ul>
      <p>Relay does not sell personal information.</p>
      <h2 id="security">Security</h2>
      <p>
        Information is separated by carrier and organization on the server, not
        only in the screens. Files are malware-scanned when a scanner is
        configured. Sign-in attempts are rate-limited. Significant actions are
        written to an audit log that cannot be edited.
      </p>
      <h2 id="keeping-and-deleting-information">
        Keeping and deleting information
      </h2>
      <p>
        Original uploaded documents are kept as versions, not overwritten.
        [Retention periods and how to request export or deletion: to be
        completed by the operator.] Until then, ask your organization
        administrator.
      </p>
      <h2 id="contact">Contact</h2>
      <p>[Operator name and privacy contact: to be completed.]</p>
    </LegalPage>
  );
}
