/**
 * The public site's menus, as data: the floating desktop mega menu and the
 * phone menu read the same list, and a browser test follows every link to prove
 * its page and its #section exist. Each page is listed once (ADR 0075).
 */
export type MenuItem = { href: string; label: string; text: string };
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
      feature: { title: string; text: string; href: string; cta: string };
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
            text: "Every load in its stage",
          },
          {
            href: "/welcome#assign",
            label: "Assign and dispatch",
            text: "Only that carrier's drivers",
          },
          {
            href: "/welcome#checkin",
            label: "Check-ins",
            text: "Source and time on every report",
          },
        ],
      },
      {
        title: "Keep records",
        items: [
          {
            href: "/how-it-works#authorize",
            label: "Authorize every carrier",
            text: "No booking without an agreement",
          },
          {
            href: "/how-it-works#paperwork",
            label: "Paperwork",
            text: "Received, accepted or missing",
          },
          {
            href: "/welcome#billing",
            label: "Bill, separately",
            text: "Carrier packet and your invoice",
          },
          {
            href: "/welcome#drafts",
            label: "Drafts from templates",
            text: "Reviewed by a person, never sent",
          },
        ],
      },
    ],
    feature: {
      title: "See it work",
      text: "Click through the real screens with sample data.",
      href: "/demo",
      cta: "Open the interactive demo",
    },
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
            text: "A verified, current agreement",
          },
          {
            href: "/how-it-works#create",
            label: "2. Create the load",
            text: "By hand or from a rate confirmation",
          },
          {
            href: "/how-it-works#assign",
            label: "3. Assign and dispatch",
            text: "With a record of who did it",
          },
        ],
      },
      {
        title: "To dispatch invoice",
        items: [
          {
            href: "/how-it-works#follow",
            label: "4. Follow it to delivery",
            text: "Check-ins with source and time",
          },
          {
            href: "/how-it-works#paperwork",
            label: "5. Collect the paperwork",
            text: "Scanned, versioned, per load",
          },
          {
            href: "/how-it-works#billing",
            label: "6. Bill, separately",
            text: "Two records, never one",
          },
        ],
      },
    ],
    feature: {
      title: "Walk through it",
      text: "The same six steps, with sample data.",
      href: "/demo",
      cta: "Open the interactive demo",
    },
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
            text: "No live carriers or money movement",
          },
          {
            href: "/welcome#status",
            label: "Where Relay is today",
            text: "What is and is not connected",
          },
          {
            href: "/pricing#ai",
            label: "AI, off until you turn it on",
            text: "You decide, with a limit",
          },
        ],
      },
      {
        title: "Try and trust",
        items: [
          {
            href: "/demo",
            label: "Interactive demo",
            text: "Fictional data, in your browser",
          },
          {
            href: "/terms",
            label: "Terms",
            text: "Draft, not yet reviewed by a lawyer",
          },
          {
            href: "/privacy",
            label: "Privacy",
            text: "What Relay stores and who sees it",
          },
        ],
      },
    ],
    feature: {
      title: "Already have access?",
      text: "Sign in to pick up where you left off.",
      href: "/",
      cta: "Sign in",
    },
  },
];
