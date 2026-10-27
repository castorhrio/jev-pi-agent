/**
 * The one place a caught value becomes a sentence the user can read.
 *
 * Main rejects every handler with a real `Error` (`toUserError()` in
 * `main/ipc.ts`), so in practice this sees an `Error` and answers its message.
 * The other branches are the contract's, not decoration: an IPC rejection can
 * carry a string, a thrown plain object never matches `instanceof Error`, and
 * `String({ … })` renders the literal text `[object Object]` — which is how
 * "the project could not be opened" reached a user as
 * `[object Object]` in the first place.
 *
 * ## Why this is not imported from `@ucad/contracts`
 *
 * The contract package ships the same function (`describeError()` in
 * `packages/contracts/src/error.ts`), and the Renderer deliberately imports no
 * *runtime* code from it: the package is CommonJS and the Vite bundle stays
 * free of it. Types are erased and still imported; this function is not.
 *
 * So there are two implementations of one behaviour, and
 * `tests/contract/error-formatting.test.ts` holds them to the same behaviour
 * table — for every value below, both must answer the same sentence. A change
 * to one that the other does not follow is a red test naming the input, which
 * is the only way a duplicate stays a copy instead of a cousin.
 *
 * ## Why every call site goes through here
 *
 * The Renderer had this expression written out at thirty-odd call sites (plus
 * four private helpers), each one a place to reintroduce `[object Object]` and
 * none of them comparable to the others. The contract test also scans this
 * directory: a renderer source file that formats a caught value with
 * `x instanceof Error ? x.message : String(x)` fails there, so the fifth copy
 * is a red gate rather than a review someone has to remember.
 */
export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'unknown error (nothing was thrown)';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      const record = value as Record<string, unknown>;
      const message = record.message;
      if (typeof message === 'string' && message.length > 0) {
        const code = record.code;
        return typeof code === 'string' ? `${code}: ${message}` : message;
      }
      // The keys, never the values: an unknown failure object is the shape a
      // secret would ride in on (NFR-08), and `[object apiKey]` says what to
      // look for without printing it.
      const keys = Object.keys(record);
      return keys.length > 0 ? `[object ${keys.slice(0, 8).join(', ')}]` : '[object]';
    } catch {
      // A getter that throws is still a failure, not a reason to throw a
      // second one out of the error path.
      return '[unreadable error]';
    }
  }
  return String(value);
}
