import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for data that must be recoverable but never stored in clear,
// such as queued email bodies containing invitation or reset links and TOTP
// secrets. RELAY_DATA_KEY is 32 random bytes, base64 encoded. Without it the
// features that depend on it fail closed and say so.
function key(): Buffer | null {
  const raw = process.env.RELAY_DATA_KEY;
  if (!raw) return null;
  const value = Buffer.from(raw, "base64");
  if (value.length !== 32)
    throw new Error("RELAY_DATA_KEY must be 32 bytes, base64 encoded");
  return value;
}
export const encryptionAvailable = () => key() !== null;
export function encrypt(plain: string): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64")))
    .join(".");
}
export function decrypt(sealed: string): string {
  const k = key();
  if (!k) throw new Error("RELAY_DATA_KEY is not configured");
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    k,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
