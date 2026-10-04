/**
 * `TokenAccounting` — turn-level usage into the §4.12.2 `UsageRecord`.
 *
 * The one rule this file exists to enforce: **a missing number stays missing.**
 * When a vendor returns no usage block, the record is `source: 'unknown'` with
 * `inputTokens` / `outputTokens` left `undefined`. A chars/4 estimate is
 * available, but only on explicit opt-in, and then it is labelled
 * `source: 'computed'` — which the summary contract already treats as
 * "estimated" and the UI already renders as a badge. Turning that into a
 * `vendor` row would be a lie that outlives the session, and `totalCostUsd`
 * derived from it would be a fabricated bill.
 *
 * Cost is computed only when a price is supplied. Without a price the field
 * stays `undefined`, which `@ucad/usage` persists as NULL — and the summary
 * reports `null`, not `0`.
 */

import type { UsageRecord } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import type { TokenUsage } from './client';

export interface TokenAccountingOptions {
  logger: Logger;
}

export interface TurnUsageInput {
  sessionId: string;
  turnId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  /** whatever the provider reported, or `{ source: 'unknown' }` */
  usage: TokenUsage;
  durationMs: number;
  /**
   * Opt-in chars/4 estimate for the case where the vendor reported nothing.
   * Off by default: an unrequested estimate is still an invented number.
   */
  estimateWhenMissing?: boolean;
  /** the text the estimate counts. Required when `estimateWhenMissing` is set. */
  text?: string;
  /** per-million-token prices. Absent price ⇒ absent cost, never zero. */
  pricing?: {
    inputPerMTokUsd?: number;
    outputPerMTokUsd?: number;
  };
}

const CHARS_PER_TOKEN = 4;

/**
 * Rough token count for providers that expose no tokenizer. Deliberately
 * crude and always reported as an estimate: ~4 characters per token is a
 * rule of thumb, not a measurement, and it is wrong by more than a factor of
 * two for CJK text and for code.
 */
export function heuristicTokenEstimate(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class TokenAccounting {
  private readonly logger: Logger;

  constructor(opts: TokenAccountingOptions) {
    this.logger = opts.logger.child('providers.usage');
  }

  toRecord(input: TurnUsageInput): UsageRecord {
    const usage = input.usage;
    const source: UsageRecord['source'] =
      usage.source === 'vendor' ? 'vendor' : usage.source === 'computed' ? 'computed' : 'unknown';

    const record: UsageRecord = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      providerId: input.providerId,
      modelId: input.modelId,
      durationMs: normaliseDuration(input.durationMs, this.logger),
      source,
    };

    if (source === 'vendor') {
      if (typeof usage.inputTokens === 'number') record.inputTokens = usage.inputTokens;
      if (typeof usage.outputTokens === 'number') record.outputTokens = usage.outputTokens;
    } else if (source === 'computed') {
      const estimate = heuristicTokenEstimate(input.text ?? '');
      if (estimate > 0) {
        // One side only: the prompt side is not derivable from the answer text,
        // so claiming both would double the fiction.
        record.outputTokens = estimate;
      } else {
        // An estimate that yields nothing is not a measurement either.
        record.source = 'unknown';
      }
    } else if (input.estimateWhenMissing === true && typeof input.text === 'string') {
      const estimate = heuristicTokenEstimate(input.text);
      if (estimate > 0) {
        record.outputTokens = estimate;
        record.source = 'computed';
      }
    }

    const cost = this.costUsd(record, input.pricing);
    if (cost !== undefined) record.costUsd = cost;

    return record;
  }

  private costUsd(
    record: UsageRecord,
    pricing: TurnUsageInput['pricing'],
  ): number | undefined {
    if (pricing === undefined) return undefined;
    const input = pricing.inputPerMTokUsd;
    const output = pricing.outputPerMTokUsd;
    const inputTokens = record.inputTokens;
    const outputTokens = record.outputTokens;
    if (
      (inputTokens === undefined || typeof input !== 'number') &&
      (outputTokens === undefined || typeof output !== 'number')
    ) {
      return undefined;
    }
    let total = 0;
    let priced = false;
    if (typeof input === 'number' && inputTokens !== undefined) {
      total += (inputTokens / 1_000_000) * input;
      priced = true;
    }
    if (typeof output === 'number' && outputTokens !== undefined) {
      total += (outputTokens / 1_000_000) * output;
      priced = true;
    }
    if (!priced) return undefined;
    // 6 decimals: below a millionth of a dollar the figure is noise anyway,
    // and a long float renders badly in the usage table.
    return Math.round(total * 1e6) / 1e6;
  }
}

function normaliseDuration(value: number, logger: Logger): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  logger.warn('turn duration was not a usable number; recording 0', { value: String(value) });
  return 0;
}
