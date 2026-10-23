import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Terms · Relay" };

export default function Terms() {
  return (
    <LegalPage
      title="Terms of use"
      sections={[
        { id: "what-relay-is", title: "What Relay is" },
        { id: "this-is-early-software", title: "This is early software" },
        { id: "accounts-and-access", title: "Accounts and access" },
        { id: "your-information", title: "Your information" },
        { id: "ai-features", title: "AI features" },
        { id: "acceptable-use", title: "Acceptable use" },
        {
          id: "changes-suspension-and-ending",
          title: "Changes, suspension and ending",
        },
        {
          id: "no-warranty-limits-and-law",
          title: "No warranty, limits and law",
        },
        { id: "who-to-contact", title: "Who to contact" },
      ]}
    >
      <h2 id="what-relay-is">What Relay is</h2>
      <p>
        Relay is software that helps a freight dispatch company manage its
        carriers: loads, documents, exceptions, messages, prospects and billing
        records. Relay is not a broker, a carrier or a bank. It does not book
        freight for you, move money, or hold funds. Invoices and payments you
        record in Relay are records you keep, not payments Relay makes or
        collects.
      </p>
      <h2 id="this-is-early-software">This is early software</h2>
      <p>
        Relay is under development. Today it runs with fictional sample data and
        has no live connections to carriers, load boards, tracking providers or
        payment systems. Anything shown as tracking is something a person
        reported, with its source and time. Do not rely on Relay for anything
        where an error would cause serious harm.
      </p>
      <h2 id="accounts-and-access">Accounts and access</h2>
      <ul>
        <li>
          Access is by invitation or by an access request that the operator
          approves. Requesting access does not create an account.
        </li>
        <li>
          Keep your sign-in details private. You are responsible for what is
          done with your account. Tell your organization administrator if you
          think it was misused.
        </li>
        <li>
          Each carrier&apos;s information is kept separate. Do not try to see
          information you were not given access to.
        </li>
      </ul>
      <h2 id="your-information">Your information</h2>
      <p>
        You keep ownership of the information you put into Relay. You allow
        Relay to store and process it to provide the service as described in the{" "}
        <a href="/privacy">Privacy page</a>. Uploaded documents are kept as
        versions so the original is never overwritten.
      </p>
      <h2 id="ai-features">AI features</h2>
      <p>
        AI features (reading documents, filling a load form from a rate
        confirmation, and the assistant) are off until an organization owner or
        admin turns them on. They only suggest. A person checks every suggestion
        and remains responsible for any load, rate, document decision or
        invoice. Do not treat AI output as an authority for booking, rate
        confirmations, invoicing or funds.
      </p>
      <h2 id="acceptable-use">Acceptable use</h2>
      <ul>
        <li>Do not upload malware or content you have no right to share.</li>
        <li>
          Do not probe, overload or bypass the security of the service, or use
          it to send unwanted messages. Messages go only to people who agreed to
          receive them.
        </li>
        <li>Do not use Relay for anything unlawful.</li>
      </ul>
      <h2 id="changes-suspension-and-ending">Changes, suspension and ending</h2>
      <p>
        The operator may change Relay or these terms, and may suspend access
        that breaks them. Material changes will be shown here with a new
        version. [Notice period and how to end an account: to be completed by
        counsel.]
      </p>
      <h2 id="no-warranty-limits-and-law">No warranty, limits and law</h2>
      <p>
        [Warranty disclaimer, limitation of liability, governing law and dispute
        process: to be completed by counsel. They are deliberately not written
        here.]
      </p>
      <h2 id="who-to-contact">Who to contact</h2>
      <p>[Operator legal name and contact email: to be completed.]</p>
    </LegalPage>
  );
}
