"use client";
import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { describe } from "@/lib/client-api";

/**
 * A failure the person needs to see, announced as an alert. Pass an error
 * code (described in plain words by `describe`) or your own message as
 * children; `onRetry` adds a Retry button. Renders nothing without either.
 */
export function ErrorAlert({
  error,
  onRetry,
  retryLabel = "Retry",
  retryDisabled = false,
  polite = false,
  children,
}: {
  error?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  /** Announce politely: for a state shown with the page, not a new failure. */
  polite?: boolean;
  children?: ReactNode;
}) {
  if (!error && !children) return null;
  return (
    <div className="alert error" role={polite ? "status" : "alert"}>
      {children ?? describe(error!)}
      {onRetry && (
        <button
          type="button"
          className="secondary"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * What a page or list shows when there is nothing in it: what is missing,
 * why, and the one action that helps. "inline" is the compact version used
 * inside panels and tables.
 */
export function EmptyState({
  icon: IconComponent,
  title,
  description,
  action,
  variant = "page",
}: {
  icon?: Icon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  variant?: "page" | "inline";
}) {
  return (
    <div
      className={variant === "page" ? "emptyState" : "emptyState inline"}
      role="status"
    >
      {IconComponent && variant === "page" && (
        <IconComponent size={32} weight="light" aria-hidden="true" />
      )}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/**
 * The line under a page's sidebar entry: a hidden page heading for screen
 * readers, a short note about the page, and its main actions on the right.
 */
export function PageIntro({
  title,
  showTitle = false,
  children,
  actions,
}: {
  /** The page name, read out but not shown (the sidebar already shows it). */
  title: string;
  /** Show the heading too, where nothing else names the view (a dialog). */
  showTitle?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="directoryIntro">
      <div>
        <h2 className={showTitle ? undefined : "srOnly"}>{title}</h2>
        {children && <p className="dirNote">{children}</p>}
      </div>
      {actions}
    </div>
  );
}
