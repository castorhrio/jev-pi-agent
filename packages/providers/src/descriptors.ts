/**
 * Provider catalogue — the built-in `ProviderDescriptor` registry.
 *
 * This file is the single place where UCAD states what a vendor *is*, and it is
 * deliberately conservative. Three rules govern every entry:
 *
 *  1. **A capability is claimed only if this package can honour it.** The
 *     transport in `client.ts` speaks OpenAI-compatible Chat Completions with
 *     SSE. It does not send tool definitions, `response_format` or image
 *     content parts, so `toolCalls`, `jsonMode` and `vision` are `false`
 *     everywhere — even for vendors famous for those features. A flag the
 *     product would then fail to deliver is worse than an honest `false`
 *     (the same rule §4.13 applies to code-intelligence `callers`, which must
 *     be *absent* rather than empty).
 *  2. **An unimplemented wire protocol is `unsupported`, not a guess.** No
 *     entry is ever pointed at a protocol this package cannot speak.
 *  3. **`baseUrl` is a default, not a truth.** Vendors move endpoints and add
 *     regional hosts. `verifiedAt` records when an entry was last checked by
 *     hand against public documentation — it is not an automated re-verification
 *     — and a stale default is corrected by the user, not by guessing here.
 *
 * A catalogue entry never contains key material. Credentials live only in the
 * vault under `{ providerId, key: secretKey }` (§4.10) and are read at call time
 * by `ProviderClient`.
 */

import type { ModelDescriptor } from '@ucad/contracts';

/** How the wire protocol is spoken by `ProviderClient`. */
export type ProviderTransport = 'openai_compatible' | 'anthropic_messages' | 'unsupported';

/**
 * What can be produced for NFR-12 token accounting.
 * `provider_tokenizer` is reserved: no entry claims it until this package
 * actually calls a vendor tokenizer endpoint.
 */
export type ProviderTokenizer = 'provider_tokenizer' | 'heuristic_chars_div_4' | 'unknown';

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  jsonMode: boolean;
  vision: boolean;
  /** whether a provider tokenizer is exposed for NFR-12 */
  tokenizer: ProviderTokenizer;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  baseUrl: string;
  /** how the wire protocol is spoken */
  transport: ProviderTransport;
  /** requires an api key; local endpoints do not */
  requiresApiKey: boolean;
  /** secret key name inside the vault, e.g. 'api-key' */
  secretKey: string;
  /** catalogued models; the user can always type a custom id */
  models: ModelDescriptor[];
  /** honest capabilities, no guessing */
  capabilities: ProviderCapabilities;
  /** documented quirks users hit; surfaced verbatim in the UI */
  notes?: string;
  docsUrl?: string;
  /** ISO date the entry was last checked by hand against public docs */
  verifiedAt: string;
  /**
   * Why `transport` is `unsupported`. Required in practice for every such
   * entry: `ProviderClient` refuses the call with this reason instead of
   * sending a request in the wrong protocol.
   */
  unsupportedReason?: string;
}

/**
 * The capability set of the transport that actually ships in this package.
 *
 * `streaming` is `true` because SSE is implemented. The other three are `false`
 * because the request builder sends no `tools`, no `response_format` and no
 * multimodal content parts. `tokenizer: 'heuristic_chars_div_4'` says UCAD can
 * offer a chars/4 *estimate* (§4.12.2 provenance `computed`) — never an exact
 * count, and only when the vendor returns no usage of its own.
 */
const OPENAI_COMPATIBLE_V1: ProviderCapabilities = Object.freeze({
  streaming: true,
  toolCalls: false,
  jsonMode: false,
  vision: false,
  tokenizer: 'heuristic_chars_div_4',
});

/** Nothing in this build can talk to Anthropic yet, so nothing is claimed. */
const UNSUPPORTED: ProviderCapabilities = Object.freeze({
  streaming: false,
  toolCalls: false,
  jsonMode: false,
  vision: false,
  tokenizer: 'unknown',
});

/** Date the built-in entries were last checked by hand against vendor docs. */
const VERIFIED_AT = '2026-10-02';

const SCOPE_NOTE =
  'Capability scope of this build: streaming text only. Tool definitions, ' +
  '`response_format` JSON mode and image parts are not sent yet, so those ' +
  'capability flags are false regardless of what the vendor supports.';

function model(providerId: string, id: string, displayName?: string): ModelDescriptor {
  return { id, providerId, displayName: displayName ?? id };
}

const ANTHROPIC_REASON =
  'Anthropic does not expose an OpenAI-compatible Chat Completions API. Its ' +
  'Messages API differs in ways a compatibility shim cannot paper over: ' +
  '`system` is a top-level field instead of a message, `max_tokens` is ' +
  'required rather than optional, credentials travel in `x-api-key` plus a ' +
  'mandatory `anthropic-version` header instead of `Authorization: Bearer`, ' +
  'and the SSE frames are content-block events (' +
  '`content_block_start` / `content_block_delta`), not `choices[].delta`. ' +
  'This build ships no `anthropic_messages` transport, so UCAD refuses the ' +
  'call instead of posting an OpenAI-shaped body to a foreign endpoint. The ' +
  'entry is kept visible so the gap is documented instead of hidden.';

export const BUILTIN_PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [model('openai', 'gpt-4o'), model('openai', 'gpt-4o-mini')],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      'Model ids here are seeds only — ModelRegistry.refresh() replaces them ' +
      'with the account\'s live list. ' + SCOPE_NOTE,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    verifiedAt: VERIFIED_AT,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    transport: 'unsupported',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [],
    capabilities: UNSUPPORTED,
    notes:
      ANTHROPIC_REASON +
      ' No model is listed because no model can be selected through UCAD yet.',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    verifiedAt: VERIFIED_AT,
    unsupportedReason: ANTHROPIC_REASON,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [model('deepseek', 'deepseek-chat'), model('deepseek', 'deepseek-reasoner')],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      '`deepseek-reasoner` streams its chain of thought in ' +
      '`delta.reasoning_content`; this transport does not surface that field, ' +
      'so only the final answer is shown. Long silent thinking is normal — the ' +
      'stream idle budget is generous for that reason. ' + SCOPE_NOTE,
    docsUrl: 'https://api-docs.deepseek.com/',
    verifiedAt: VERIFIED_AT,
  },
  {
    id: 'qwen',
    displayName: '通义千问 / Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [model('qwen', 'qwen3-max'), model('qwen', 'qwen3-coder-plus')],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      'DashScope is reachable from mainland China on the default host and ' +
      'internationally on dashscope-intl; if the default host is unreachable ' +
      'from this machine the base URL is the first thing to check. ' + SCOPE_NOTE,
    docsUrl:
      'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    verifiedAt: VERIFIED_AT,
  },
  {
    id: 'glm',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [model('glm', 'glm-4-plus'), model('glm', 'glm-4-flash')],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      'Function calling is one of this vendor\'s strengths, but UCAD does not ' +
      'send tool definitions yet, so `toolCalls` is false here on purpose. ' +
      SCOPE_NOTE,
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    verifiedAt: VERIFIED_AT,
  },
  {
    id: 'kimi',
    displayName: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [model('kimi', 'moonshot-v1-8k'), model('kimi', 'moonshot-v1-128k')],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      'Context length is per-model, not per-provider: the `-8k` / `-128k' +
      ' suffixes are the context class and belong in the model id. ' + SCOPE_NOTE,
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    verifiedAt: VERIFIED_AT,
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    // Model ids are vendor/model routes. This is also why model identity is
    // `providerId + modelId`: `openrouter:deepseek/deepseek-chat` and
    // `deepseek:deepseek-chat` are different routes with different pricing.
    models: [
      model('openrouter', 'deepseek/deepseek-chat'),
      model('openrouter', 'openai/gpt-4o'),
    ],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      'Aggregator: one key, many upstream vendors, and a second billing layer. ' +
      'Model ids are `<vendor>/<model>` routes and the live list is the only ' +
      'authority — refresh the registry before trusting these seeds. ' + SCOPE_NOTE,
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
    verifiedAt: VERIFIED_AT,
  },
  {
    id: 'local',
    displayName: 'Local (Ollama / LM Studio)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    transport: 'openai_compatible',
    requiresApiKey: false,
    secretKey: 'api-key',
    // Empty on purpose: what a local runtime can serve is whatever this
    // machine has pulled. ModelRegistry.refresh() reads that list from
    // `GET /v1/models`; a hard-coded guess would be fiction.
    models: [],
    capabilities: OPENAI_COMPATIBLE_V1,
    notes:
      'Ollama default port. LM Studio and llama.cpp servers speak the same ' +
      'shape on a different port (1234 / 8080) — point the base URL there. ' +
      'No key is sent, so an accidentally stored key is never forwarded to a ' +
      'local process. Token usage may be absent for some local backends; UCAD ' +
      'then reports usage as unknown rather than guessing (§4.12.2).',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    verifiedAt: VERIFIED_AT,
  },
];

const BY_ID: ReadonlyMap<string, ProviderDescriptor> = new Map(
  BUILTIN_PROVIDERS.map((p) => [p.id, p]),
);

/**
 * Look up one built-in provider. `undefined` for an unknown id — callers turn
 * that into an `AppError`, they do not fall back to a default provider, because
 * silently calling a different vendor than the user picked is not a default,
 * it is a wrong answer.
 */
export function getProvider(id: string): ProviderDescriptor | undefined {
  return BY_ID.get(id);
}

/** Copy of the catalogue; callers may sort or filter it freely. */
export function listProviders(): ProviderDescriptor[] {
  return [...BUILTIN_PROVIDERS];
}
