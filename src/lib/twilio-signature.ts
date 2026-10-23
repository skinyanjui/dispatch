import { createHmac } from "node:crypto";
export function twilioSignature(
  token: string,
  url: string,
  params: URLSearchParams,
) {
  const keys = [...new Set([...params.keys()])].sort();
  const data = keys.reduce((s, k) => s + k + params.getAll(k).join(""), url);
  return createHmac("sha1", token).update(data).digest("base64");
}
