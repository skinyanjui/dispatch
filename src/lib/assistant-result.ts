/** Keep tool responses valid JSON and complete records within the model budget. */
export function boundedToolResult(data: unknown, limit: number) {
  const original = JSON.stringify(data);
  if (original.length <= limit) return original;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return JSON.stringify({ error: "Result too large. Narrow the lookup." });
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
  result.truncated = true;
  const lists = Object.values(result).filter(Array.isArray);
  while (JSON.stringify(result).length > limit) {
    const largest = lists
      .filter((list) => list.length > 0)
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!largest)
      return JSON.stringify({ error: "Result too large. Narrow the lookup." });
    largest.pop();
    if (typeof result.shown === "number" && lists.length === 1)
      result.shown = largest.length;
  }
  if (!lists.some((list) => list.length))
    return JSON.stringify({ error: "Result too large. Narrow the lookup." });
  return JSON.stringify(result);
}
