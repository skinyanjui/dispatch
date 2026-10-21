"use client";
import { useEffect, useRef } from "react";
import { XIcon } from "@phosphor-icons/react";
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
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="overlay"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
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
