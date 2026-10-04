/**
 * @ucad/usage — token and cost accounting with explicit provenance.
 *
 * The rule this package exists to enforce (§4.12.2): when a vendor does not
 * report reliable numbers, the UI must show "unavailable" rather than a
 * fabricated figure. A record's `source` therefore travels all the way into
 * the summary's `estimated` flag, and `totalCostUsd` is `null` — not `0` — when
 * nothing knows the price.
 */

import type { Database } from '@ucad/storage';
import type { UsageRecord, UsageSummaryDto } from '@ucad/contracts';
import { ulid, nowIso } from '@ucad/observability';
import type { Logger } from '@ucad/observability';

export interface UsageStoreOptions {
  db: Database;
  logger: Logger;
}

interface UsageRow {
  id: string;
  session_id: string;
  turn_id: string;
  agent_id: string;
  provider_id: string | null;
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number;
  source: string;
  created_at: string;
}

export interface UsageFilter {
  sessionId?: string;
  workspaceId?: string;
  from?: string;
  to?: string;
}

export class UsageStore {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(opts: UsageStoreOptions) {
    this.db = opts.db;
    this.logger = opts.logger.child('usage');
  }

  record(record: UsageRecord): void {
    this.db.driver.run(
      `INSERT INTO usage_records
         (id, session_id, turn_id, agent_id, provider_id, model_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, duration_ms, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ulid('use_'),
        record.sessionId,
        record.turnId,
        record.agentId,
        record.providerId ?? null,
        record.modelId ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.cacheReadTokens ?? null,
        record.cacheWriteTokens ?? null,
        record.costUsd ?? null,
        Math.max(0, Math.round(record.durationMs)),
        record.source,
        nowIso(),
      ],
    );
  }

  query(filter: UsageFilter): UsageRecord[] {
    const { where, params } = this.buildWhere(filter);
    const rows = this.db.driver.all<UsageRow>(
      `SELECT * FROM usage_records ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(toRecord);
  }

  /**
   * Aggregation deliberately refuses to invent a cost. If no record carries a
   * `costUsd`, the summary reports `null` and the UI renders "unavailable"
   * rather than 0.
   */
  summary(filter: UsageFilter): UsageSummaryDto {
    const { where, params } = this.buildWhere(filter);
    const rows = this.db.driver.all<UsageRow>(
      `SELECT * FROM usage_records ${where} ORDER BY created_at ASC`,
      params,
    );

    let totalInput = 0;
    let totalOutput = 0;
    let estimated = false;
    let anyCost = false;
    let totalCost = 0;

    const byAgent = new Map<
      string,
      { input: number; output: number; cost: number | null }
    >();
    const byModel = new Map<
      string,
      { input: number; output: number; cost: number | null }
    >();

    for (const row of rows) {
      const input = row.input_tokens ?? 0;
      const output = row.output_tokens ?? 0;
      totalInput += input;
      totalOutput += output;

      if (row.source === 'computed' || row.source === 'unknown') {
        estimated = true;
      }
      if (row.cost_usd !== null) {
        anyCost = true;
        totalCost += row.cost_usd;
      }

      const agentBucket = byAgent.get(row.agent_id) ?? {
        input: 0,
        output: 0,
        cost: null,
      };
      agentBucket.input += input;
      agentBucket.output += output;
      if (row.cost_usd !== null) agentBucket.cost = (agentBucket.cost ?? 0) + row.cost_usd;
      byAgent.set(row.agent_id, agentBucket);

      const modelId = row.model_id ?? 'unknown';
      const modelBucket = byModel.get(modelId) ?? { input: 0, output: 0, cost: null };
      modelBucket.input += input;
      modelBucket.output += output;
      if (row.cost_usd !== null) modelBucket.cost = (modelBucket.cost ?? 0) + row.cost_usd;
      byModel.set(modelId, modelBucket);
    }

    return {
      from: filter.from ?? rows[0]?.created_at ?? nowIso(),
      to: filter.to ?? rows[rows.length - 1]?.created_at ?? nowIso(),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: anyCost ? Number(totalCost.toFixed(6)) : null,
      estimated,
      byAgent: [...byAgent.entries()].map(([agentId, v]) => ({
        agentId,
        inputTokens: v.input,
        outputTokens: v.output,
        costUsd: v.cost,
      })),
      byModel: [...byModel.entries()].map(([modelId, v]) => ({
        modelId,
        inputTokens: v.input,
        outputTokens: v.output,
        costUsd: v.cost,
      })),
    };
  }

  /** Retention (§8.4): drop usage rows older than the configured window. */
  purgeOlderThan(isoCutoff: string): number {
    const result = this.db.driver.run(
      'DELETE FROM usage_records WHERE created_at < ?',
      [isoCutoff],
    );
    this.logger.info('purged usage records', { changes: result.changes, cutoff: isoCutoff });
    return result.changes;
  }

  private buildWhere(filter: UsageFilter): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.workspaceId) {
      clauses.push(
        'session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)',
      );
      params.push(filter.workspaceId);
    }
    if (filter.from) {
      clauses.push('created_at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push('created_at <= ?');
      params.push(filter.to);
    }

    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }
}

function toRecord(row: UsageRow): UsageRecord {
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cache_read_tokens !== null ? { cacheReadTokens: row.cache_read_tokens } : {}),
    ...(row.cache_write_tokens !== null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    durationMs: row.duration_ms,
    source: (row.source as UsageRecord['source']) ?? 'unknown',
  };
}
