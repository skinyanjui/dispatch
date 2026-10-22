"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/modal";

export type Command = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
};

/**
 * A keyboard-first menu for going anywhere or starting something without
 * hunting through the sidebar. Type to filter, arrows to move, Enter to run.
 * (A common pattern in CRMs; written for Relay, sharing no code with them.)
 */
export function CommandPalette({
  commands,
  searchLoads,
  onClose,
}: {
  commands: Command[];
  /** Offered as the last result when text is typed. */
  searchLoads: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(""),
    [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const needle = text.trim().toLowerCase();
  const results = useMemo(() => {
    const matched = commands.filter(
      (c) =>
        !needle ||
        `${c.group} ${c.label} ${c.hint ?? ""}`.toLowerCase().includes(needle),
    );
    const extra: Command[] = needle
      ? [
          {
            id: "search-loads",
            group: "Search",
            label: `Search loads for “${text.trim()}”`,
            run: () => searchLoads(text.trim()),
          },
        ]
      : [];
    return [...matched.slice(0, 40), ...extra];
  }, [commands, needle, text, searchLoads]);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const at = Math.min(active, results.length - 1);
  let lastGroup = "";
  return (
    <Modal label="Command menu" onClose={onClose}>
      <div className="palette">
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={
            results[at] ? "cmd-" + results[at].id : undefined
          }
          aria-label="Type a command or search"
          placeholder="Type a command or search…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(Math.min(results.length - 1, at + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(0, at - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(results[at]);
            }
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="Commands">
          {results.map((c, i) => {
            const heading = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {heading && <small className="paletteGroup">{c.group}</small>}
                <div
                  id={"cmd-" + c.id}
                  role="option"
                  aria-selected={i === at}
                  className={"paletteItem" + (i === at ? " active" : "")}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <span>{c.label}</span>
                  {c.hint && <small>{c.hint}</small>}
                </div>
              </li>
            );
          })}
          {!results.length && <li className="paletteEmpty">No matches.</li>}
        </ul>
        <small className="paletteFoot">
          ↑ ↓ to move · Enter to open · Esc to close
        </small>
      </div>
    </Modal>
  );
}
