import { test, expect, type Page } from "@playwright/test";

/**
 * Alignment audit over the demo pages. Two detectors run in the page:
 *  - cards: in a row of sibling cards, the figure or heading and the first
 *    link or button sit at the same offset in every card;
 *  - rows: down a list, the same action (Message, Call, Edit...) sits at the
 *    same place in every row, whichever other actions a row has.
 * A failure names the page, the list and the measured offsets.
 */
const CARDS = `(() => {
  const framed = (e) => { const c = getComputedStyle(e);
    return (parseFloat(c.borderTopWidth) > 0 && c.borderTopStyle !== 'none') || (c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'rgb(255, 255, 255)'); };
  const isCard = (e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e);
    return framed(e) && r.height > 36 && r.width > 90 && c.display !== 'inline' && e.children.length > 0 && !/srOnly/.test(e.className) && !['TR','TD','TH','TABLE','THEAD','TBODY'].includes(e.tagName) && !e.closest('table'); };
  const keys = (card) => [...card.querySelectorAll('strong, h2, h3, h4, a, button, .statAction')].filter(k => k.getBoundingClientRect().height > 4 && !/srOnly/.test(k.className));
  const res = { examined: 0, issues: [] };
  const parents = new Set(document.querySelectorAll('body, body *'));
  for (const parent of parents) {
    const kids = [...parent.children].filter(isCard);
    if (kids.length < 2) continue;
    const groups = {};
    for (const k of kids) (groups[Math.round(k.getBoundingClientRect().top)] ??= []).push(k);
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      res.examined++;
      const info = g.map(card => { const t = card.getBoundingClientRect(); const m = {};
        for (const k of keys(card)) { const r = k.getBoundingClientRect(); const tag = k.tagName.toLowerCase(); (m[tag] ??= []).push({ top: Math.round(r.top - t.top), bottom: Math.round(t.bottom - r.bottom), text: (k.textContent||'').trim().slice(0,16) }); }
        return m; });
      const problems = [];
      for (const tag of ['strong','h2','h3','h4']) { const tops = info.map(m => m[tag]?.[0]?.top).filter(v => v !== undefined); if (tops.length > 1 && new Set(tops).size > 1) problems.push(tag + ' top ' + tops.join('/')); }
      for (const tag of ['a','button']) { const first = info.map(m => m[tag]?.[0]).filter(Boolean); if (first.length > 1 && new Set(first.map(f => f.bottom)).size > 1 && new Set(first.map(f=>f.top)).size > 1) problems.push(tag + ' bottom ' + first.map(f => f.bottom + '(' + f.text + ')').join('/')); }
      if (problems.length) res.issues.push({ parent: (parent.className||parent.tagName).toString().slice(0,30), cards: g.length, problems });
    }
  }
  return res; })()`;
const ROWS = `(() => {
  const res = { lists: 0, issues: [] };
  const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\\\s+/g,' ').split(' ')[0].slice(0,16);
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  for (const parent of document.querySelectorAll('body, body *')) {
    if (parent.closest('table, thead')) continue;
    const kids = [...parent.children].filter(k => visible(k) && k.querySelector('button, a') && !k.classList.contains('stats'));
    if (kids.length < 2) continue;
    const sig = (k) => k.tagName + '.' + (k.className||'').toString().split(' ')[0];
    const bySig = {}; for (const k of kids) (bySig[sig(k)] ??= []).push(k);
    for (const rows of Object.values(bySig)) {
      if (rows.length < 2) continue;
      // stacked: distinct tops, similar left edge
      const tops = new Set(rows.map(r => Math.round(r.getBoundingClientRect().top)));
      const lefts = new Set(rows.map(r => Math.round(r.getBoundingClientRect().left)));
      if (tops.size < rows.length || lefts.size > 1) continue;
      res.lists++;
      const pos = {};
      for (const r of rows) { const rr = r.getBoundingClientRect();
        for (const b of r.querySelectorAll('button, a')) { if (!visible(b)) continue; const l = label(b); if (!l) continue; const br = b.getBoundingClientRect();
          (pos[l] ??= []).push({ x: Math.round(br.left - rr.left), right: Math.round(rr.right - br.right) }); } }
      const bad = [];
      for (const [l, v] of Object.entries(pos)) { if (v.length < 2) continue; if (new Set(v.map(p => p.x)).size > 1 && new Set(v.map(p => p.right)).size > 1) bad.push(l + ': x ' + [...new Set(v.map(p => p.x))].join('/') + ' | right ' + [...new Set(v.map(p => p.right))].join('/')); }
      if (bad.length) res.issues.push({ list: (parent.className||parent.tagName).toString().slice(0,28), rows: rows.length, bad: bad.slice(0,6) });
    }
  }
  return res; })()`;

const pages = [
  "Loads",
  "Exceptions",
  "Inbox",
  "Contacts",
  "Carriers",
  "Fleet",
  "Prospects",
  "Assistant",
  "Documents",
  "Billing",
  "Reports",
];

type Result = { examined?: number; lists?: number; issues: unknown[] };

async function audit(page: Page, label: string) {
  const c = (await page.evaluate(CARDS)) as Result;
  const r = (await page.evaluate(ROWS)) as Result;
  expect(c.issues, `${label}: cards`).toEqual([]);
  expect(r.issues, `${label}: rows`).toEqual([]);
}

for (const width of [1440, 390]) {
  test(`cards and list rows line up on every demo page at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/demo");
    const open = async (name: string, menu = false) => {
      if (width < 800) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await page
          .locator(".navigationSheet")
          .getByText(name, { exact: true })
          .first()
          .click();
      } else if (menu) {
        await page.getByRole("button", { name: "Account menu" }).click();
        await page.getByRole("button", { name, exact: true }).first().click();
      } else {
        await page
          .getByRole("navigation", { name: "Workspace navigation" })
          .getByRole("button", { name, exact: true })
          .click();
      }
      await page.waitForTimeout(600);
    };
    for (const name of pages) {
      await open(name);
      await audit(page, name);
    }
    for (const name of ["Account", "Notifications"]) {
      await open(name, true);
      await audit(page, name);
    }
  });
}

test("the detectors do flag a misaligned row (self-test)", async ({ page }) => {
  await page.setContent(
    `<body><div style="display:flex;gap:8px"><div style="border:1px solid #000;width:200px;padding:8px"><strong>1</strong><p>a</p><p>b</p><a href="#">Open</a></div><div style="border:1px solid #000;width:200px;padding:8px"><strong>2</strong><a href="#">Open</a></div></div>` +
      `<ul style="list-style:none;padding:0"><li style="display:flex;gap:8px;width:400px"><span>A</span><button>Msg</button><button>Edit</button></li><li style="display:flex;gap:8px;width:400px"><span>B</span><button>Msg</button></li><li style="display:flex;gap:8px;width:400px"><span>CCCCCCCC</span><button>Msg</button></li></ul></body>`,
  );
  expect(
    ((await page.evaluate(CARDS)) as Result).issues.length,
  ).toBeGreaterThan(0);
  expect(((await page.evaluate(ROWS)) as Result).issues.length).toBeGreaterThan(
    0,
  );
});
