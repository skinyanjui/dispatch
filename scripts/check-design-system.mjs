// Guards the design system (docs/design-system.md): patterns that have one
// canonical component must not be rebuilt inline. Runs with `npm run lint`.
import { readFileSync, readdirSync, statSync } from "node:fs";
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
];

const problems = [];
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
