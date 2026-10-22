"use client";
import { useEffect } from "react";
import Link from "next/link";
import { StatusPage } from "@/components/status-page";
import { errorDigest, logUiError } from "@/lib/ui-error";

export default function ErrorPage({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => logUiError(error), [error]);
  const digest = errorDigest(error);
  return (
    <StatusPage
      code="Something went wrong"
      title="This page couldn’t load."
      alert
      actions={
        <>
          <button type="button" className="primary" onClick={() => retry()}>
            Try again
          </button>
          <Link className="secondary" href="/">
            Go to Relay
          </Link>
        </>
      }
    >
      Nothing you entered was lost or sent.
      {digest
        ? ` If it keeps happening, tell support this code: ${digest}.`
        : ""}
    </StatusPage>
  );
}
