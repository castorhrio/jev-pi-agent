/**
 * §7.2 Settings snapshot: one JSON document in `settings` under the key `app`
 * (§8.1 `settings(key, value_json, updated_at)`).
 *
 * `getSettings()` must always return a *complete* snapshot — the IPC contract
 * (`settings.get`) hands it straight to the Renderer, so a missing field is a
 * contract violation. The stored document is therefore normalized field by
 * field against the defaults instead of being trusted as-is.
 */

import { DECISION_HARD_TIMEOUT_MS, DEFAULT_DECISION_CHAIN } from '@ucad/contracts';
import type {
  ContextBudget,
  ContextStrategy,
  DeepPartial,
  McpServerDto,
  PermissionMode,
  SettingsSnapshot,
  TokenEstimateSource,
} from '@ucad/contracts';

/** `settings.key` of the single settings document. */
export const SETTINGS_KEY = 'app';

/** §8.4 default retention for `events` / `messages`. */
export const DEFAULT_RETENTION_DAYS = 90;

export const PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  'read_only',
  'ask',
  'workspace_write',
];

export const CONTEXT_STRATEGIES: ReadonlyArray<ContextStrategy | 'auto'> = [
  'auto',
  'text_first',
  'graph_first',
  'hybrid',
];

export const TOKEN_ESTIMATE_SOURCES: ReadonlyArray<TokenEstimateSource> = [
  'provider_tokenizer',
  'heuristic_chars_div_4',
  'unknown',
];

/** V1 defaults. D-1: the decision chain starts as `['rule']`. */
export const DEFAULT_SETTINGS: Readonly<SettingsSnapshot> = Object.freeze({
  version: 1,
  locale: 'zh-CN' as const,
  agent: {
    // the Desktop owns the agent catalog; an empty id means "not chosen yet"
    // and is never a fabricated vendor id (NFR-04)
    defaultAgentId: '',
    permissionMode: 'ask' as PermissionMode,
  },
  provider: {
    // Same rule as `defaultAgentId`: empty means "no preference", never a
    // made-up vendor id. A remembered choice is an initial value for the
    // composer picker, not a value that overrides an explicit "follow".
    defaultProviderId: '',
  },
  decision: {
    // D-1 / DEFAULT_DECISION_CHAIN
    chain: [...DEFAULT_DECISION_CHAIN],
    // NFR-14: no network engines unless the user says so
    autoRoute: false,
    allowNetworkEngines: false,
    timeoutMs: DECISION_HARD_TIMEOUT_MS,
  },
  context: {
    strategy: 'auto' as const,
    budget: {
      maxInputTokens: 60_000,
      reservedOutputTokens: 8_000,
      // T-2: the Basic provider has no tokenizer
      estimateSource: 'heuristic_chars_div_4' as TokenEstimateSource,
    },
    maxItemsPerPack: 40,
  },
  intelligence: {
    // §5: Basic is the always-available provider
    defaultProviderId: 'basic',
    allowAdvanced: false,
  },
  storage: {
    retentionDays: DEFAULT_RETENTION_DAYS,
    // NFR-15: the real value is read from the Database protection state; this is
    // only the fallback when storage cannot report it
    encryptionEnabled: false,
  },
  mcp: { servers: [] },
}) as SettingsSnapshot;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive merge used by `patchSettings`. Plain objects merge key by key;
 * arrays and primitives (including `null`) replace wholesale.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T {
  return typeof value === 'string' && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeBudget(raw: unknown, fallback: ContextBudget): ContextBudget {
  const budget = asRecord(raw);
  return {
    maxInputTokens: asPositiveInt(budget['maxInputTokens'], fallback.maxInputTokens),
    reservedOutputTokens: asPositiveInt(
      budget['reservedOutputTokens'],
      fallback.reservedOutputTokens,
    ),
    estimateSource: asEnum(
      budget['estimateSource'],
      TOKEN_ESTIMATE_SOURCES,
      fallback.estimateSource,
    ),
  };
}

function normalizeServers(raw: unknown): McpServerDto[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  // Shape is owned by @ucad/mcp; keep the entries verbatim but drop non-objects.
  return raw.filter((item): item is McpServerDto => isPlainObject(item));
}

/**
 * Coerce an arbitrary stored value into a complete, valid `SettingsSnapshot`.
 * Every field falls back to {@link DEFAULT_SETTINGS}, so the result never has an
 * `undefined` member.
 */
export function normalizeSettings(raw: unknown): SettingsSnapshot {
  const root = asRecord(raw);
  const d = DEFAULT_SETTINGS;
  const agent = asRecord(root['agent']);
  const provider = asRecord(root['provider']);
  const decision = asRecord(root['decision']);
  const context = asRecord(root['context']);
  const intelligence = asRecord(root['intelligence']);
  const storage = asRecord(root['storage']);
  const mcp = asRecord(root['mcp']);

  return {
    version: asPositiveInt(root['version'], d.version),
    locale: asEnum(root['locale'], ['zh-CN', 'en-US'] as const, d.locale),
    agent: {
      defaultAgentId: asString(agent['defaultAgentId'], d.agent.defaultAgentId),
      permissionMode: asEnum(agent['permissionMode'], PERMISSION_MODES, d.agent.permissionMode),
    },
    provider: {
      defaultProviderId: asString(provider['defaultProviderId'], d.provider.defaultProviderId),
    },
    decision: {
      chain: asStringArray(decision['chain'], d.decision.chain),
      autoRoute: asBoolean(decision['autoRoute'], d.decision.autoRoute),
      allowNetworkEngines: asBoolean(
        decision['allowNetworkEngines'],
        d.decision.allowNetworkEngines,
      ),
      timeoutMs: asPositiveInt(decision['timeoutMs'], d.decision.timeoutMs),
    },
    context: {
      strategy: asEnum(context['strategy'], CONTEXT_STRATEGIES, d.context.strategy),
      budget: normalizeBudget(context['budget'], d.context.budget),
      maxItemsPerPack: asPositiveInt(
        context['maxItemsPerPack'],
        d.context.maxItemsPerPack,
      ),
    },
    intelligence: {
      defaultProviderId: asString(
        intelligence['defaultProviderId'],
        d.intelligence.defaultProviderId,
      ),
      allowAdvanced: asBoolean(intelligence['allowAdvanced'], d.intelligence.allowAdvanced),
    },
    storage: {
      retentionDays:
        storage['retentionDays'] === null
          ? null
          : asPositiveInt(storage['retentionDays'], d.storage.retentionDays ?? DEFAULT_RETENTION_DAYS),
      // overwritten with the real protection state by SessionStore.getSettings
      encryptionEnabled: asBoolean(storage['encryptionEnabled'], d.storage.encryptionEnabled),
    },
    mcp: { servers: normalizeServers(mcp['servers']) },
  };
}

/**
 * `patchSettings` bumps `version`; the caller never sets it explicitly so a
 * patch can not roll the version back.
 */
export function applySettingsPatch(
  current: SettingsSnapshot,
  patch: DeepPartial<SettingsSnapshot>,
): SettingsSnapshot {
  const merged = normalizeSettings(deepMerge(current, patch));
  return { ...merged, version: current.version + 1 };
}
