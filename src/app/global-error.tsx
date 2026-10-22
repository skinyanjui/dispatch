"use client";
import { useEffect } from "react";
import { errorDigest, logUiError } from "@/lib/ui-error";

/** Replaces the root layout, so it carries its own document and styles. */
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => logUiError(error), [error]);
  const digest = errorDigest(error);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          color: "#1a1a1a",
          background: "#f7f7f5",
        }}
      >
        <main role="alert" style={{ maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>
            Relay couldn’t load.
          </h1>
          <p style={{ lineHeight: 1.5 }}>
            Nothing you entered was lost or sent.
            {digest ? ` Support code: ${digest}.` : ""}
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              minHeight: 36,
              padding: "0 16px",
              border: 0,
              borderRadius: 8,
              background: "#2f4cf5",
              color: "#fff",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
