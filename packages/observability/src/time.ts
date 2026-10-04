/** ISO-8601 UTC with millisecond precision. */
export function nowIso(): string {
  return new Date().toISOString();
}
