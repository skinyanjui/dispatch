"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon, ListIcon, XIcon } from "@phosphor-icons/react";
import { Brand } from "@/components/workspace-shell";
import { menu, type MenuEntry } from "@/lib/marketing-menu";
import { AuthorizeVisual, PaperworkVisual } from "@/components/step-visuals";

type Menu = Extract<MenuEntry, { kind: "menu" }>;

/**
 * The public site's navigation: a mega menu from 900px (hover, click or
 * keyboard; Escape closes and returns focus), and a full-height sheet on
 * phones. Both read src/lib/marketing-menu.ts.
 */
export function MarketingNav({ current }: { current: string }) {
  const [open, setOpen] = useState<string | null>(null);
  // A menu opened by hover is pinned by the click that follows it (the pointer
  // is already over the trigger); only a click on a pinned menu closes it.
  const pinned = useRef(false);
  const bar = useRef<HTMLDivElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const sheet = useRef<HTMLDialogElement>(null);
  const base = useId();

  const close = useCallback((returnFocus = false) => {
    setOpen((was) => {
      if (was && returnFocus) triggers.current[was]?.focus();
      return null;
    });
    pinned.current = false;
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    const onPointer = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  const isCurrent = (href: string) => href.split("#")[0] === current;
  return (
    <div className="mkNavWrap" ref={bar} onMouseLeave={() => close()}>
      <nav aria-label="Main" className="mkNav">
        {menu.map((entry) =>
          entry.kind === "link" ? (
            <Link
              key={entry.href}
              href={entry.href}
              className="mkNavLink"
              aria-current={entry.href === current ? "page" : undefined}
              onMouseEnter={() => close()}
            >
              {entry.label}
            </Link>
          ) : (
            <button
              key={entry.id}
              type="button"
              className="mkNavLink mkNavTrigger"
              ref={(el) => {
                triggers.current[entry.id] = el;
              }}
              aria-expanded={open === entry.id}
              aria-controls={`${base}-${entry.id}`}
              data-current={entry.page === current ? "true" : undefined}
              onClick={() => {
                if (open === entry.id && pinned.current) close();
                else {
                  setOpen(entry.id);
                  pinned.current = true;
                }
              }}
              onMouseEnter={() => {
                if (open !== entry.id) pinned.current = false;
                setOpen(entry.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setOpen(entry.id);
                  pinned.current = true;
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLElement>(
                        `#${CSS.escape(`${base}-${entry.id}`)} a`,
                      )
                      ?.focus(),
                  );
                }
              }}
            >
              {entry.label}
              <CaretDownIcon size={12} aria-hidden="true" />
            </button>
          ),
        )}
      </nav>
      <div className="mkNavActions">
        <Link href="/" className="mkNavLink">
          Sign in
        </Link>
        <Link className="mkButton" href="/request-access">
          Request access
        </Link>
      </div>
      <button
        type="button"
        className="mkMenuButton"
        aria-label="Open menu"
        onClick={() => sheet.current?.showModal()}
      >
        <ListIcon size={20} aria-hidden="true" />
      </button>

      {menu.map(
        (entry) =>
          entry.kind === "menu" &&
          open === entry.id && (
            <MegaPanel
              key={entry.id}
              id={`${base}-${entry.id}`}
              entry={entry}
              isCurrent={isCurrent}
              onNavigate={() => close()}
            />
          ),
      )}

      <dialog
        ref={sheet}
        className="mkSheet"
        aria-label="Menu"
        onClick={(e) => e.target === sheet.current && sheet.current.close()}
      >
        <div className="mkSheetHead">
          <Link
            href="/welcome"
            aria-label="Relay home"
            onClick={() => sheet.current?.close()}
          >
            <Brand />
          </Link>
          <button
            type="button"
            className="mkMenuButton"
            aria-label="Close menu"
            onClick={() => sheet.current?.close()}
          >
            <XIcon size={20} aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Menu" className="mkSheetNav">
          {menu.map((entry) =>
            entry.kind === "link" ? (
              <Link
                key={entry.href}
                href={entry.href}
                className="mkSheetLink"
                aria-current={entry.href === current ? "page" : undefined}
                onClick={() => sheet.current?.close()}
              >
                {entry.label}
              </Link>
            ) : (
              <details key={entry.id} className="mkSheetGroup">
                <summary>{entry.label}</summary>
                {entry.groups.map((g) => (
                  <div key={g.title}>
                    <p>{g.title}</p>
                    <ul>
                      {g.items.map((item) => (
                        <li key={item.href + item.label}>
                          <Link
                            href={item.href}
                            onClick={() => sheet.current?.close()}
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            ),
          )}
        </nav>
        <div className="mkSheetActions">
          <Link
            className="mkButton"
            href="/request-access"
            onClick={() => sheet.current?.close()}
          >
            Request access
          </Link>
          <Link
            className="mkGhost"
            href="/"
            onClick={() => sheet.current?.close()}
          >
            Sign in
          </Link>
        </div>
      </dialog>
    </div>
  );
}

function MegaPanel({
  id,
  entry,
  isCurrent,
  onNavigate,
}: {
  id: string;
  entry: Menu;
  isCurrent: (href: string) => boolean;
  onNavigate: () => void;
}) {
  return (
    <div
      id={id}
      className="mkMega"
      role="region"
      aria-label={`${entry.label} menu`}
    >
      <div className="mkMegaGroups">
        {entry.groups.map((g) => (
          <div key={g.title} className="mkMegaGroup">
            <p className="mkMegaTitle">{g.title}</p>
            <ul>
              {g.items.map((item) => (
                <li key={item.href + item.label}>
                  <Link
                    href={item.href}
                    aria-current={
                      isCurrent(item.href) && !item.href.includes("#")
                        ? "page"
                        : undefined
                    }
                    onClick={onNavigate}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mkMegaFeature">
        <p className="mkMegaTitle">{entry.feature.title}</p>
        <p>{entry.feature.text}</p>
        {entry.id === "product" && <PaperworkVisual />}
        {entry.id === "how" && <AuthorizeVisual />}
        <Link
          className="mkGhost"
          href={entry.feature.href}
          onClick={onNavigate}
        >
          {entry.feature.cta}
        </Link>
      </div>
    </div>
  );
}
