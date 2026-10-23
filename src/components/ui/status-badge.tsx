import type { ReactNode } from "react";

export type StatusTone = "neutral" | "good" | "warn" | "bad";

/**
 * A short status in a pill. The words carry the meaning; the tone colour
 * only reinforces it (never colour alone), using the status tokens.
 */
export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <span className={"opsPill" + (tone === "neutral" ? "" : " " + tone)}>
      {children}
    </span>
  );
}
