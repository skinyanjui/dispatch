# 0041 — Public pages: product-page look, breadcrumb and list rows

## Decision

The public pages (`/welcome`, `/how-it-works`, `/get-started`, `/pricing`) follow the structure and tone of a CRM product page, as requested: a centered hero, a tabbed picture of the workspace, three short cards, alternating feature rows, a "where we are today" band and a closing call to action, in a neutral palette with large tight headings and hairline frames, matching the signed-in look (ADR 0039).

Two small shared components were written for Relay after reading the public descriptions of the reference design system's primitives (ideas only, no code; ADR 0036):

- `Breadcrumb` (`src/components/ui/breadcrumb.tsx`): an ordered trail in a `nav`, decorative `/` separators hidden from assistive technology, the last item marked `aria-current="page"` whether or not it links, long labels truncated.
- `ListItem` / `ListItems` (`src/components/ui/list-item.tsx`): one row layout with an optional start icon, a label, supporting text inline, below or at the end, and trailing content; a passive list item so links and buttons inside keep native behavior.

The hero picture is plain markup with made-up sample values and says "A drawing with made-up sample values, not live data", so nothing is presented as live (AGENTS.md).

## Not done

The reference design system's published component gallery could not be reached from this environment, so colors and spacing come from the screenshots supplied by the product owner rather than from that gallery.
