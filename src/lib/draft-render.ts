/**
 * Pure template filling, kept apart so it is cheap to test: no database, no
 * network, no clock. An empty or unknown value is never guessed; it stays
 * visible as [missing: field] and is reported so a reviewer cannot miss it.
 */
export const FIELD = /\{\{\s*([a-z_.]+)\s*\}\}/g;

export function render(body: string, values: Record<string, string>) {
  const missing: string[] = [];
  const text = body.replace(FIELD, (_, field: string) => {
    const v = values[field];
    if (v === undefined || v === "") {
      if (!missing.includes(field)) missing.push(field);
      return `[missing: ${field}]`;
    }
    return v;
  });
  return { text, missing };
}
