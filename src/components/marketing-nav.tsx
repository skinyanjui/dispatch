"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon, ListIcon, XIcon } from "@phosphor-icons/react";
import { Brand } from "@/components/workspace-shell";
import { menu, type MenuEntry } from "@/lib/marketing-menu";

type Menu = Extract<MenuEntry, { kind: "menu" }>;

/**
 * The public site's navigation, inside the floating bar (ADR 0075): a
 * dropdown card under each trigger from 900px, and below that a card that
 * opens over the bar. Both read src/lib/marketing-menu.ts.
 *
 * Desktop: a mouse opens a panel by hovering its trigger; a click (or
 * ArrowDown) pins it so the pointer can leave. Each panel sits right after its
 * trigger in the DOM, so Tab walks into its links. Escape closes it and
 * returns focus; so do an outside click, focus leaving the menu, and
 * following a link.
 */
export function MarketingNav({ current }: { current: string }) {
  const [open, setOpen] = useState<{ id: string; pinned: boolean } | null>(
    null,
  );
  const wrap = useRef<HTMLDivElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusPanel = useRef(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const base = useId();
  const panelId = (id: string) => `${base}-${id}`;
  const openId = open?.id ?? null;

  useEffect(() => {
    if (!openId) return;
    if (focusPanel.current) {
      focusPanel.current = false;
      wrap.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(panelId(openId))} a`)
        ?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      triggers.current[openId]?.focus();
      setOpen(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
    // panelId only depends on `base`, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // The card is for narrow screens; if the window grows past the breakpoint
  // while it is open, close it so the page behind is not left inert.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 900px)");
    const onChange = () => wide.matches && sheet.current?.close();
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  const closeSheet = () => sheet.current?.close();
  const isCurrent = (href: string) => href.split("#")[0] === current;
  return (
    <div
      className="mkNavWrap"
      ref={wrap}
      onMouseLeave={() => setOpen(null)}
      onBlur={(e) => {
        // Focus moving anywhere but the open trigger or its panel closes it;
        // focus leaving the window (no related target) does not.
        const next = e.relatedTarget as Node | null;
        if (!next || !openId) return;
        const panel = document.getElementById(panelId(openId));
        if (!panel?.contains(next) && triggers.current[openId] !== next)
          setOpen(null);
      }}
    >
      <nav aria-label="Main" className="mkNav">
        {menu.map((entry) =>
          entry.kind === "link" ? (
            <Link
              key={entry.href}
              href={entry.href}
              className="mkNavLink"
              aria-current={entry.href === current ? "page" : undefined}
              onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(null)}
            >
              {entry.label}
            </Link>
          ) : (
            <MenuTrigger
              key={entry.id}
              entry={entry}
              panelId={panelId(entry.id)}
              expanded={openId === entry.id}
              isCurrent={isCurrent}
              register={(el) => {
                triggers.current[entry.id] = el;
              }}
              onToggle={() =>
                setOpen((was) =>
                  was?.id === entry.id && was.pinned
                    ? null
                    : { id: entry.id, pinned: true },
                )
              }
              onHover={() =>
                setOpen((was) =>
                  was?.id === entry.id ? was : { id: entry.id, pinned: false },
                )
              }
              onArrowDown={() => {
                focusPanel.current = true;
                setOpen({ id: entry.id, pinned: true });
              }}
              onNavigate={() => setOpen(null)}
            />
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

      <dialog
        ref={sheet}
        className="mkSheet"
        aria-label="Menu"
        onClick={(e) => e.target === sheet.current && closeSheet()}
      >
        <div className="mkSheetBody">
          <div className="mkSheetHead">
            <Link href="/welcome" aria-label="Relay home" onClick={closeSheet}>
              <Brand />
            </Link>
            <button
              type="button"
              className="mkMenuButton"
              aria-label="Close menu"
              onClick={closeSheet}
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
                  onClick={closeSheet}
                >
                  {entry.label}
                </Link>
              ) : (
                <details key={entry.id} className="mkSheetGroup" name="mkSheet">
                  <summary>
                    {entry.label}
                    <CaretDownIcon size={16} aria-hidden="true" />
                  </summary>
                  {entry.groups.map((g) => (
                    <div key={g.title}>
                      <p>{g.title}</p>
                      <ul>
                        {g.items.map((item) => (
                          <li key={item.href + item.label}>
                            <Link href={item.href} onClick={closeSheet}>
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
              onClick={closeSheet}
            >
              Request access
            </Link>
            <Link className="mkGhost" href="/" onClick={closeSheet}>
              Sign in
            </Link>
          </div>
        </div>
      </dialog>
    </div>
  );
}

function MenuTrigger({
  entry,
  panelId,
  expanded,
  isCurrent,
  register,
  onToggle,
  onHover,
  onArrowDown,
  onNavigate,
}: {
  entry: Menu;
  panelId: string;
  expanded: boolean;
  isCurrent: (href: string) => boolean;
  register: (el: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onHover: () => void;
  onArrowDown: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className="mkNavItem">
      <button
        type="button"
        className="mkNavLink mkNavTrigger"
        ref={register}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        data-current={isCurrent(entry.page ?? "") ? "true" : undefined}
        onClick={onToggle}
        onPointerEnter={(e) => e.pointerType === "mouse" && onHover()}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          onArrowDown();
        }}
      >
        {entry.label}
        <CaretDownIcon size={12} aria-hidden="true" />
      </button>
      {expanded && (
        <div
          id={panelId}
          className="mkMega"
          role="region"
          aria-label={`${entry.label} menu`}
        >
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
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
