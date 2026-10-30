/**
 * The public site's menus, as data: the floating desktop mega menu and the
 * phone menu read the same list, and a browser test follows every link to prove
 * its page and its #section exist. Labels only, each page listed once (ADR 0075).
 */
export type MenuItem = { href: string; label: string };
export type MenuGroup = { title: string; items: MenuItem[] };
export type MenuEntry =
  | { kind: "link"; href: string; label: string }
  | {
      kind: "menu";
      id: string;
      label: string;
      /** The page this menu belongs to, for the current-page mark. */
      page?: string;
      groups: MenuGroup[];
    };

export const menu: MenuEntry[] = [
  {
    kind: "menu",
    id: "product",
    label: "Product",
    page: "/welcome",
    groups: [
      {
        title: "Run dispatch",
        items: [
          {
            href: "/welcome#board",
            label: "Board, table and calendar",
          },
          {
            href: "/welcome#assign",
            label: "Assign and dispatch",
          },
          {
            href: "/welcome#checkin",
            label: "Check-ins",
          },
        ],
      },
      {
        title: "Keep records",
        items: [
          {
            href: "/how-it-works#authorize",
            label: "Authorize every carrier",
          },
          {
            href: "/how-it-works#paperwork",
            label: "Paperwork",
          },
          {
            href: "/welcome#billing",
            label: "Bill, separately",
          },
          {
            href: "/welcome#drafts",
            label: "Drafts from templates",
          },
        ],
      },
    ],
  },
  {
    kind: "menu",
    id: "how",
    label: "How it works",
    page: "/how-it-works",
    groups: [
      {
        title: "From rate confirmation",
        items: [
          {
            href: "/how-it-works#authorize",
            label: "1. Authorize the carrier",
          },
          {
            href: "/how-it-works#create",
            label: "2. Create the load",
          },
          {
            href: "/how-it-works#assign",
            label: "3. Assign and dispatch",
          },
        ],
      },
      {
        title: "To dispatch invoice",
        items: [
          {
            href: "/how-it-works#follow",
            label: "4. Follow it to delivery",
          },
          {
            href: "/how-it-works#paperwork",
            label: "5. Collect the paperwork",
          },
          {
            href: "/how-it-works#billing",
            label: "6. Bill, separately",
          },
        ],
      },
    ],
  },
  { kind: "link", href: "/get-started", label: "Get started" },
  { kind: "link", href: "/pricing", label: "Pricing" },
  {
    kind: "menu",
    id: "resources",
    label: "Resources",
    groups: [
      {
        title: "Know the limits",
        items: [
          {
            href: "/how-it-works#limits",
            label: "What it does not do",
          },
          {
            href: "/welcome#status",
            label: "Where Relay is today",
          },
          {
            href: "/pricing#ai",
            label: "AI, off until you turn it on",
          },
        ],
      },
      {
        title: "Try and trust",
        items: [
          {
            href: "/demo",
            label: "Interactive demo",
          },
          {
            href: "/terms",
            label: "Terms",
          },
          {
            href: "/privacy",
            label: "Privacy",
          },
        ],
      },
    ],
  },
];
