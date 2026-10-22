/**
 * A tiny PDF writer for plain text: A4 pages, one built-in font, wrapped
 * lines, an optional heading and a one-line banner. No dependency and no
 * network. Only characters the built-in font can show (Latin-1) are kept;
 * smart quotes and dashes are mapped, anything else becomes "?".
 */
const PAGE = { w: 595, h: 842, margin: 56 };
const SIZE = 11;
const LEADING = 15;

const latin = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/→/g, "->")
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, "?");
const escape = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Helvetica averages about half the point size per character. */
function wrap(text: string, width: number) {
  const max = Math.floor(width / (SIZE * 0.5));
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= max) line += " " + word;
      else {
        lines.push(line);
        line = word;
      }
      while (line.length > max) {
        lines.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function textPdf(opts: {
  title: string;
  banner?: string;
  body: string;
}): Buffer {
  const width = PAGE.w - PAGE.margin * 2;
  const linesPerPage = Math.floor((PAGE.h - PAGE.margin * 2) / LEADING);
  const all = [
    ...(opts.banner ? [`[${latin(opts.banner)}]`, ""] : []),
    ...wrap(latin(opts.title), width),
    "",
    ...wrap(latin(opts.body), width),
  ];
  const pages: string[][] = [];
  for (let i = 0; i < all.length; i += linesPerPage)
    pages.push(all.slice(i, i + linesPerPage));
  if (!pages.length) pages.push([""]);

  // Objects: 1 catalog, 2 pages, 3 font, then a page and a stream per page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    const content =
      `BT /F1 ${SIZE} Tf ${LEADING} TL ${PAGE.margin} ${PAGE.h - PAGE.margin - SIZE} Td ` +
      lines.map((l) => `(${escape(l)}) Tj T*`).join(" ") +
      " ET";
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
