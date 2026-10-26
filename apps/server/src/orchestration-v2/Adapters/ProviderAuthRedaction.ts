import * as Schema from "effect/Schema";

const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const keyName = (key: string) => key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const secretKey = (key: string) =>
  /(?:authorization|apikey|token|password|secret|codeverifier)$/.test(keyName(key));
const oauthUrlKey = (key: string) =>
  /^(?:authorizationurl|authurl|loginurl|callbackurl|redirecturi)$/.test(keyName(key));
const privateQuery =
  /[?&](?:code|state|token|access_token|id_token|refresh_token|code_verifier|client_secret)=/i;

/** Authentication controls must never put callback URLs, codes, state or tokens in protocol logs. */
export function redactProviderAuthValue(value: unknown, oauth = false): unknown {
  if (typeof value === "string") {
    if (/^Bearer\s+/i.test(value)) return "[REDACTED]";
    const text = value.trim();
    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      try {
        return toJson(redactProviderAuthValue(fromJson(text), oauth));
      } catch {
        /* A protocol line can be incomplete. */
      }
    }
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      privateQuery.test(url) ? "[REDACTED AUTH URL]" : url,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => redactProviderAuthValue(entry, oauth));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value);
  const isOauth =
    oauth ||
    entries.some(
      ([key, nested]) =>
        oauthUrlKey(key) ||
        (key === "method" &&
          typeof nested === "string" &&
          /(?:oauth|sign.?in|login|auth\/complete)/i.test(nested)),
    );
  return Object.fromEntries(
    entries.map(([key, nested]) => [
      key,
      secretKey(key) ||
      oauthUrlKey(key) ||
      (isOauth && /^(?:code|state|credentials)$/.test(keyName(key)))
        ? "[REDACTED]"
        : redactProviderAuthValue(nested, isOauth),
    ]),
  );
}
