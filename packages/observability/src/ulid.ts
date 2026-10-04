/**
 * ULID: 10 chars of Crockford base32 timestamp + 16 chars of randomness.
 * Lexicographically sortable, which is what makes `events.id` and
 * `turns.started_at` cheap to reason about.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod] + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function randomChars(): number[] {
  const out: number[] = new Array(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    out[i] = Math.floor(Math.random() * ENCODING_LEN);
  }
  return out;
}

/** Increments the previous random block, so ULIDs minted in the same ms stay ordered. */
function bumpRandom(prev: number[]): number[] {
  const out = prev.slice();
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const current = out[i] ?? 0;
    if (current < ENCODING_LEN - 1) {
      out[i] = current + 1;
      return out;
    }
    out[i] = 0;
  }
  return randomChars();
}

function randomToString(chars: number[]): string {
  return chars.map((c) => ENCODING[c] ?? '0').join('');
}

export function rawUlid(): string {
  const now = Date.now();
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + randomToString(lastRandom);
}

/**
 * Prefixed identifier. Prefixes are how the codebase keeps ids legible in logs
 * and lets a reader tell `cp_` (context pack) from `bl_` (blob) at a glance.
 */
export function ulid(prefix?: string): string {
  const id = rawUlid();
  return prefix ? `${prefix}${id}` : id;
}
