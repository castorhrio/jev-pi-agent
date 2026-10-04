/** §4.12.2 Usage. */

export interface UsageRecord {
  sessionId: string;
  turnId: string;
  agentId: string;
  providerId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  durationMs: number;
  /** 'computed' / 'unknown' MUST be surfaced as an estimate in the UI. */
  source: 'vendor' | 'computed' | 'unknown';
}

export interface UsageSummaryDto {
  from: string;
  to: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number | null;
  /** true if any record is 'computed' or 'unknown' — the UI must label it. */
  estimated: boolean;
  byAgent: Array<{
    agentId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }>;
  byModel: Array<{
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }>;
}
