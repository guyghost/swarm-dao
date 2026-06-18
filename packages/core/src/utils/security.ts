// ============================================================
// Swarm DAO Core — Security Utilities
// ============================================================

/**
 * Recursively redacts sensitive fields in an object.
 * Replaces values of keys like 'token', 'secret', 'password', 'key' with '[REDACTED]'.
 */
const SENSITIVE_KEY_LIST = ["token", "secret", "password", "key", "apikey"];

export function redactSensitiveFields<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item)) as unknown as T;
  }

  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lowerKey = k.toLowerCase();
    const isSensitive = SENSITIVE_KEY_LIST.some((s) => lowerKey.includes(s));
    if (isSensitive && typeof v === "string" && v.length > 0) {
      redacted[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      redacted[k] = redactSensitiveFields(v);
    } else {
      redacted[k] = v;
    }
  }

  return redacted as T;
}
