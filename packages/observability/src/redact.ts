/**
 * NFR-08: Secret / Authorization material must not appear in any log.
 *
 * `redact` returns a new structure; the input is never mutated, because callers
 * pass live objects such as `PermissionRequest`.
 */

const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|secret|token|password|passwd|credential|cookie|bearer|session[-_]?key|private[-_]?key)/i;

const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bsk-[A-Za-z0-9\-_]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // key=value forms inside free text (log lines, shell echoes)
  /\b((?:api[-_]?key|secret|token|password|passwd|access[-_]?token)\s*[=:]\s*)("?)([^\s"',;]+)\2/gi,
];

export const REDACTED = '[redacted]';

export function redactText(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match, prefix?: string) =>
      // the key=value pattern carries a capture group for the key part
      typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redact<T>(value: T): T {
  return redactInner(value, 0) as T;
}

const MAX_DEPTH = 12;

function redactInner(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]';

  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
    };
  }

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) {
      out[String(k)] = SECRET_KEY_PATTERN.test(String(k))
        ? REDACTED
        : redactInner(v, depth + 1);
    }
    return out;
  }

  if (value instanceof Set) {
    return [...value].map((item) => redactInner(item, depth + 1));
  }

  if (!isPlainObject(value)) {
    // class instances are summarized rather than deep-copied, so a getter
    // with a side effect cannot run during logging
    return { __type: value.constructor?.name ?? 'Object' };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactInner(item, depth + 1);
  }
  return out;
}
