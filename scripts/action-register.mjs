import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
async function files(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((d) =>
        d.isDirectory() ? files(dir + "/" + d.name) : [dir + "/" + d.name],
      ),
    )
  ).flat();
}
const controls = [],
  actions = [],
  hash = createHash("sha256");
for (const file of (await files("src"))
  .filter((f) => /\.tsx?$/.test(f))
  .sort()) {
  const text = await readFile(file, "utf8");
  hash.update(file + "\0" + text + "\0");
  const ast = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const line = (node) =>
    ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const compact = (node) =>
    node.getText(ast).replace(/\s+/g, " ").slice(0, 600);
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const handlers = node.attributes.properties.filter(
        (a) =>
          ts.isJsxAttribute(a) &&
          /^(on[A-Z]|href$|action$)/.test(a.name.getText(ast)),
      );
      if (handlers.length)
        controls.push({
          file,
          line: line(node),
          component: node.tagName.getText(ast),
          handlers: handlers.map((a) => ({
            name: a.name.getText(ast),
            implementation: compact(a.initializer ?? a),
          })),
        });
    }
    if (
      file === "src/app/api/[...path]/route.ts" &&
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression)
    ) {
      const call = node.expression;
      if (!['readJson','readBody'].includes(call.expression.getText(ast))) {
        const conditions = [];
        let parent = node.parent;
        while (parent) {
          if (ts.isIfStatement(parent))
            conditions.unshift(compact(parent.expression));
          parent = parent.parent;
        }
        actions.push({
          file,
          line: line(node),
          domainFunction: call.expression.getText(ast),
          conditions,
          contract: compact(call),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const report = {
  generatedBy: "npm run audit:actions",
  sourceTreeSHA256: hash.digest("hex"),
  baselineRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  note: "Source-linked register. Runtime evidence and review limits are in repair-status.md; a handler listing is not proof of a successful click-through.",
  controls,
  actions,
};
await writeFile(
  "docs/repairs/action-register.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `${controls.length} interactive control sites; ${actions.length} API awaited-call sites registered.`,
);
