import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../../src/lib/draft-render";
import { textPdf } from "../../src/lib/simple-pdf";

test("render fills known fields, tolerates spacing, and flags empty ones without guessing", () => {
  const out = render(
    "Hi {{ carrier.contact }}, load {{load.reference}} / {{load.reference}} {{load.driver}}.",
    {
      "carrier.contact": "Jordan",
      "load.reference": "QA-1",
      "load.driver": "",
    },
  );
  assert.equal(out.text, "Hi Jordan, load QA-1 / QA-1 [missing: load.driver].");
  assert.deepEqual(out.missing, ["load.driver"]);
  // A field the caller never supplied is missing too; braces that are not fields stay.
  const two = render("{{a.b}} {x} {{nope}}", { "a.b": "ok" });
  assert.equal(two.text, "ok {x} [missing: nope]");
  // Values are inserted as text, never re-read as fields.
  assert.equal(render("{{a.b}}", { "a.b": "{{c.d}}" }).text, "{{c.d}}");
});

test("textPdf writes a valid, wrapped, multi-page PDF with a correct cross-reference table", () => {
  const body = Array.from(
    { length: 120 },
    (_, i) => `Line ${i} with (parens) and a \\ slash – and “quotes”`,
  ).join("\n");
  const pdf = textPdf({
    title: "Check call - QA-1",
    banner: "DRAFT - not reviewed",
    body,
  });
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  const pages = (text.match(/\/Type \/Page /g) ?? []).length;
  assert.ok(pages >= 3, "paginates long text");
  assert.match(text, /DRAFT - not reviewed/);
  assert.match(text, /\\\(parens\\\)/); // parentheses are escaped
  assert.ok(!text.includes("“"), "no characters outside Latin-1");
  // Every xref entry points at its object.
  const start = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(start).startsWith("xref"));
  const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)];
  entries.forEach((m, i) =>
    assert.ok(
      text.slice(Number(m[1])).startsWith(`${i + 1} 0 obj`),
      `object ${i + 1}`,
    ),
  );
  assert.equal(
    textPdf({ title: "T", body: "" }).toString("latin1").includes("/Count 1"),
    true,
  );
});
