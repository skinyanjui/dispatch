// Text messages (ADR 0018). Off unless RELAY_SMS_TRANSPORT=twilio with
// credentials. Each text is attempted once: a timeout or network failure may
// still have reached the recipient, so it is reported as "unknown" and never
// retried automatically, to avoid duplicate texts.
export type SmsResult =
  | { ok: true; providerId: string | null }
  | { ok: false; definite: boolean; error: string };
export type SmsTransport = {
  name: string;
  send(
    to: string,
    body: string,
    reference?: { id: string; attempt: number },
  ): Promise<SmsResult>;
};

/** E.164 for US/Canada numbers, or null when the number is not dialable. */
export function toE164(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  const only = digits.replace(/\D/g, "");
  if (only.length === 10) return "+1" + only;
  if (only.length === 11 && only.startsWith("1")) return "+" + only;
  return null;
}

function twilio(sid: string, token: string, from: string): SmsTransport {
  return {
    name: "twilio",
    async send(to, body, reference) {
      try {
        const response = await fetch(
          `${process.env.TWILIO_API_BASE || "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization:
                "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: to,
              From: from,
              Body: body,
              ...(process.env.APP_ORIGIN?.startsWith("https://")
                ? {
                    StatusCallback: new URL(
                      "/api/webhooks/sms-status" +
                        (reference
                          ? "?delivery_id=" +
                            encodeURIComponent(reference.id) +
                            "&attempt=" +
                            reference.attempt
                          : ""),
                      process.env.APP_ORIGIN,
                    ).toString(),
                  }
                : {}),
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
        if (response.ok)
          return {
            ok: true,
            providerId:
              ((await response.json()) as { sid?: string }).sid ?? null,
          };
        // 4xx means the provider refused it outright; 5xx is ambiguous.
        return {
          ok: false,
          definite: response.status >= 400 && response.status < 500,
          error: `Provider responded ${response.status}`,
        };
      } catch {
        return {
          ok: false,
          definite: false,
          error: "No answer from the provider",
        };
      }
    },
  };
}

let override: SmsTransport | null | undefined;
export function setSmsTransport(transport: SmsTransport | null | undefined) {
  override = transport;
}
export function smsTransport(): SmsTransport | null {
  if (override !== undefined) return override;
  if (process.env.RELAY_SMS_TRANSPORT !== "twilio") return null;
  const {
    TWILIO_ACCOUNT_SID: sid,
    TWILIO_AUTH_TOKEN: token,
    TWILIO_FROM: from,
  } = process.env;
  return sid && token && from ? twilio(sid, token, from) : null;
}
