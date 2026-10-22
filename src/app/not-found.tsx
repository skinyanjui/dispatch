import type { Metadata } from "next";
import Link from "next/link";
import { StatusPage } from "@/components/status-page";

export const metadata: Metadata = { title: "Page not found · Relay" };

/** Also what a load, invoice or carrier link shows when the record does not
 *  exist or is not yours: the two cases look the same on purpose. */
export default function NotFound() {
  return (
    <StatusPage
      code="404"
      title="We can’t find that page."
      actions={
        <Link className="primary" href="/">
          Go to Relay
        </Link>
      }
    >
      The address may be mistyped, or the record may be gone or not available to
      your account.
    </StatusPage>
  );
}
