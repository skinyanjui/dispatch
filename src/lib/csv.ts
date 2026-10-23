/** Spreadsheet formulas in cells are neutralised; quotes are doubled. */
export function csvCell(value: unknown) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
