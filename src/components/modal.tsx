"use client";
import { useEffect, useRef } from "react";
import { XIcon } from "@phosphor-icons/react";
// The element that had focus just before a dialog opened. A disabled opener
// loses focus while its data loads, so the browser alone cannot return to it.
let lastFocused: HTMLElement | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "focusin",
    (event) => {
      if (event.target instanceof HTMLElement) lastFocused = event.target;
    },
    true,
  );

export function Modal({
  children,
  label,
  onClose,
}: {
  children: React.ReactNode;
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = lastFocused;
    dialog?.showModal();
    return () => {
      dialog?.close();
      // Back to where the person was once the page has settled.
      requestAnimationFrame(() => {
        // A person may already have focused their next control. Do not steal
        // that focus when the delayed restoration callback runs.
        const current = document.activeElement;
        if (
          current &&
          current !== document.body &&
          current !== dialog &&
          !dialog?.contains(current)
        )
          return;
        if (opener?.isConnected && !(opener as HTMLButtonElement).disabled)
          opener.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="overlay"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        // React would otherwise bubble Escape to a dialog this one sits in.
        event.stopPropagation();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

/** A modal drawer with the standard panel, eyebrow and close button. */
export function Sheet({
  children,
  label,
  eyebrow,
  onClose,
}: {
  children: React.ReactNode;
  label: string;
  eyebrow: string;
  onClose: () => void;
}) {
  return (
    <Modal label={label} onClose={onClose}>
      <section className="inspector">
        <div className="inspectorHeader">
          <p className="eyebrow">{eyebrow}</p>
          <button
            type="button"
            className="iconButton"
            aria-label={`Close ${label.toLowerCase()}`}
            onClick={onClose}
          >
            <XIcon size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </Modal>
  );
}
