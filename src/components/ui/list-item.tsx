import type { ReactNode } from "react";

/**
 * One consistent row: an optional start icon or avatar, a label, supporting
 * text (inline, below or at the end), and trailing content. It is a passive
 * `li`; put a link or button inside `children` when the row should act, so
 * keyboard and screen-reader behavior stays native.
 */
export function ListItem({
  start,
  children,
  description,
  descriptionPlacement = "below",
  end,
}: {
  start?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  descriptionPlacement?: "inline" | "below" | "end";
  end?: ReactNode;
}) {
  return (
    <li className={"listItem " + descriptionPlacement}>
      {start && (
        <span className="listItemStart" aria-hidden="true">
          {start}
        </span>
      )}
      <span className="listItemBody">
        <span className="listItemLabel">{children}</span>
        {description && <span className="listItemDesc">{description}</span>}
      </span>
      {end && <span className="listItemEnd">{end}</span>}
    </li>
  );
}

export function ListItems({
  label,
  children,
  ordered = false,
}: {
  label: string;
  children: ReactNode;
  ordered?: boolean;
}) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className="listItems" aria-label={label}>
      {children}
    </Tag>
  );
}
