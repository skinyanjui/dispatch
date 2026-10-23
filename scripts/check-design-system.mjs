// Guards the design system (docs/design-system.md): patterns that have one
// canonical component must not be rebuilt inline. Runs with `npm run lint`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(tsx|css)$/.test(name)) files.push(path);
  }
})(join(root, "src"));

/**
 * Each rule: what is not allowed, where the canonical version lives, and the
 * only files allowed to contain it, each with its reason.
 */
const rules = [
  {
    name: "inline SVG",
    test: /<svg[\s>]/,
    in: /\.tsx$/,
    use: "an icon from @phosphor-icons/react, or HTML and CSS (BarList, meter, borders)",
    allow: {},
  },
  {
    name: "inline style",
    test: /\sstyle=\{/,
    in: /\.tsx$/,
    use: "a class in the stylesheets, or a component variant",
    allow: {
      // Replaces the root layout when the app itself fails, so the app's
      // stylesheets may not have loaded.
      "src/app/global-error.tsx": "renders without the app stylesheets",
    },
  },
  {
    name: "raw table",
    test: /<table[\s>]/,
    in: /\.tsx$/,
    use: "DataTable from components/ui/data-table with column definitions",
    allow: { "src/components/ui/data-table.tsx": "the canonical table" },
  },
  {
    name: "field name repeated in each row",
    test: /data-label=|attr\(data-label\)/,
    in: /\.(tsx|css)$/,
    use: "column headers (DataTable); narrow screens scroll sideways",
    allow: {},
  },
  {
    name: "hand-built tab list",
    test: /role="tablist"/,
    in: /\.tsx$/,
    use: "Tabs and TabPanel from components/ui/tabs",
    allow: { "src/components/ui/tabs.tsx": "the canonical tabs" },
  },
  {
    name: "hand-formatted date or number",
    test: /\.toLocale(String|DateString|TimeString)\(/,
    in: /\.tsx$/,
    use: "a helper from src/lib/format.ts",
    allow: {},
  },
  {
    name: "hand-built error alert",
    test: /className="alert error"/,
    in: /\.tsx$/,
    use: "ErrorAlert from components/ui/feedback",
    allow: { "src/components/ui/feedback.tsx": "the canonical alert" },
  },
  {
    name: "hand-built empty state or page intro",
    test: /className="(directoryEmpty|emptyState|directoryIntro)"/,
    in: /\.tsx$/,
    use: "EmptyState or PageIntro from components/ui/feedback",
    allow: { "src/components/ui/feedback.tsx": "the canonical versions" },
  },
];

/** Raw colours belong in src/app/tokens.css; no other stylesheet has any. */
const hex = /#[0-9a-fA-F]{3,8}\b/g;

const problems = [];
// Every token used is defined, and only tokens.css holds raw colours.
const defined = new Set();
const used = [];
for (const path of files) {
  const file = relative(root, path);
  const text = readFileSync(path, "utf8");
  if (file.endsWith(".css"))
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  for (const m of text.matchAll(/var\((--[\w-]+)/g)) used.push([file, m[1]]);
  if (file.endsWith(".css") && file !== "src/app/tokens.css") {
    const found = (text.match(hex) ?? []).length;
    if (found)
      problems.push(
        `${file}: ${found} raw colour(s): use a token from src/app/tokens.css`,
      );
  }
}
/**
 * Spacing (padding, margin, gap) comes from the --space-* scale. A literal px
 * value is allowed only as a 1-2px hairline or optical nudge. A literal that
 * equals a token must be the token. Older off-scale literals are counted per
 * file in scripts/spacing-baseline.json, which may only shrink: fix some, then
 * lower the number.
 */
const spacingDecl =
  /(?<![\w-])((?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap)\s*:\s*([^;{}]*)/g;
const scale = { 4: 1, 8: 2, 12: 3, 16: 4, 20: 5, 24: 6, 32: 7, 40: 8 };
const baselinePath = join(root, "scripts/spacing-baseline.json");
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {};
const offScale = {};
for (const path of files) {
  const file = relative(root, path);
  if (!file.endsWith(".css") || file === "src/app/tokens.css") continue;
  const text = readFileSync(path, "utf8");
  for (const m of text.matchAll(spacingDecl)) {
    if (m[2].includes("calc(")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    for (const v of m[2].matchAll(/(?<![\w.-])(-?\d+(?:\.\d+)?)px\b/g)) {
      const n = Math.abs(Number(v[1]));
      if (n <= 2) continue;
      if (scale[n] && Number(v[1]) > 0)
        problems.push(
          `${file}:${line} ${m[1]}: ${v[0]} is a token, use var(--space-${scale[n]})`,
        );
      else (offScale[file] ??= []).push(line);
    }
  }
}
for (const file of new Set([
  ...Object.keys(offScale),
  ...Object.keys(baseline),
])) {
  const found = offScale[file]?.length ?? 0;
  const allowed = baseline[file] ?? 0;
  if (found > allowed)
    problems.push(
      `${file}: ${found} off-scale spacing value(s), ${allowed} allowed; use var(--space-1..8) (lines ${offScale[file].join(", ")})`,
    );
  else if (found < allowed)
    problems.push(
      `${file}: ${found} off-scale spacing value(s) left; lower scripts/spacing-baseline.json from ${allowed} to ${found}`,
    );
}
for (const [file, name] of used)
  if (!defined.has(name))
    problems.push(`${file}: ${name} is not a defined token`);
for (const path of files) {
  const file = relative(root, path);
  const text = readFileSync(path, "utf8");
  for (const rule of rules) {
    if (!rule.in.test(file) || rule.allow[file]) continue;
    text.split("\n").forEach((line, i) => {
      if (rule.test.test(line))
        problems.push(`${file}:${i + 1} ${rule.name}: use ${rule.use}`);
    });
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} design-system violation(s).`);
  process.exit(1);
}
console.log("Design system checks passed.");
