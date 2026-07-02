const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function assertSafeJsonValue(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeJsonValue(item, context);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) {
      throw new Error(`Unsafe key "${key}" in ${context}`);
    }
    assertSafeJsonValue(nested, context);
  }
}

export function parseSafeJson<T>(input: string, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid JSON in ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSafeJsonValue(parsed, context);
  return parsed as T;
}
