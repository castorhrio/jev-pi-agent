/**
 * §4.5.3 T-1/T-2/T-3 — the `TokenEstimator` of the Basic tier.
 *
 * T-1: the estimator declares where its numbers come from, and that declaration
 * travels into `ContextBudget.estimateSource`, into the `context.pack.built`
 * payload and into the UI. A budget presented without provenance is a lie told
 * to the user, so `source` is `readonly` and is never 'provider_tokenizer' here:
 * the Basic provider has no tokenizer, only characters.
 */

import type { TokenEstimateSource, TokenEstimator } from '@ucad/contracts';

/** §4.5.3 T-2: ASCII is charged at 0.25 tokens/char. */
const ASCII_TOKENS_PER_CHAR = 0.25;

/** T-2: CJK is charged at 0.6 tokens/char — it costs more per character. */
const CJK_TOKENS_PER_CHAR = 0.6;

/**
 * Code point ranges that are billed like CJK. Deliberately a superset of
 * CJK Unified Ideographs: kana, Hangul, fullwidth forms and CJK punctuation
 * all tokenize at roughly the same density as Chinese.
 */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals .. CJK punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, Hangul compat, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * The V1 token estimator. Pure: no clock, no randomness, no global state, so
 * the same text always yields the same number (T-2 "must be monotonic") and a
 * rendered pack can be re-audited after a restart.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  /**
   * T-3: the honest declaration. The Basic provider's tokenizer is
   * `heuristic_chars_div_4` (C-4), so every budget derived from this estimator
   * is reported as estimated, never as counted.
   */
  readonly source: TokenEstimateSource = 'heuristic_chars_div_4';

  /**
   * `ctx` is accepted for interface compatibility (a provider tokenizer may
   * need `modelId`) and deliberately ignored: the heuristic has no per-model
   * variation to model, and pretending otherwise would be invented precision.
   */
  estimate(text: string, _ctx?: { modelId?: string; providerId?: string }): number {
    if (text.length === 0) return 0;

    let units = 0;
    // Iterates by code point, so an emoji or a surrogate pair is charged once.
    for (const char of text) {
      units += isWideChar(char.codePointAt(0) ?? 0) ? CJK_TOKENS_PER_CHAR : ASCII_TOKENS_PER_CHAR;
    }

    // Round up: a partial token is still a token the provider will charge for.
    return Math.max(1, Math.ceil(units));
  }
}
