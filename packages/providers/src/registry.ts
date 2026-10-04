/**
 * `ModelRegistry` — the per-workspace model catalogue.
 *
 * Model identity is `providerId + modelId`, never a bare string.
 * `deepseek:deepseek-chat` and `openrouter:deepseek/deepseek-chat` are
 * different routes bought at different prices through different billing
 * accounts, and a registry that cannot tell them apart will eventually bill
 * one for the other.
 *
 * Three sources feed the catalogue, in increasing authority:
 *  1. the built-in seeds in `descriptors.ts`,
 *  2. whatever `ProviderClient.listModels()` reports for the account,
 *  3. a custom id the user typed (always allowed — the catalogue is a
 *     convenience, not a gate; `ProviderClient` accepts any model string).
 */

import type { ModelDescriptor } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { BUILTIN_PROVIDERS } from './descriptors';
import type { ProviderClient, SecretLike } from './client';

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ModelRegistryOptions {
  client: ProviderClient;
  logger: Logger;
}

/** `providerId::modelId` — the composite key that keeps routes distinct. */
function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export class ModelRegistry {
  private readonly client: ProviderClient;
  private readonly logger: Logger;
  private readonly models = new Map<string, ModelDescriptor>();

  constructor(opts: ModelRegistryOptions) {
    this.client = opts.client;
    this.logger = opts.logger.child('providers.registry');
    for (const provider of BUILTIN_PROVIDERS) {
      for (const model of provider.models) {
        this.register(provider.id, model);
      }
    }
  }

  /** Everything catalogued so far, stable order: provider, then model id. */
  list(): ModelDescriptor[] {
    return [...this.models.values()].sort((a, b) => {
      if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /**
   * Ask a provider what it actually serves and merge the answer in. Seeds are
   * kept even if the vendor stops listing them: a model that disappeared from
   * `/models` is usually a routing quirk, not a retraction, and silently
   * deleting it would break a pinned workspace.
   */
  async refresh(providerId: string, signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const found = await this.client.listModels(providerId, signal);
    for (const model of found) {
      this.register(providerId, model);
    }
    this.logger.info('model registry refreshed', {
      providerId,
      received: found.length,
      total: this.models.size,
    });
    return this.list().filter((model) => model.providerId === providerId);
  }

  /** Add or replace one model. `model.providerId` is overwritten by the argument. */
  register(providerId: string, model: ModelDescriptor): void {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (id.length === 0) return;
    this.models.set(modelKey(providerId, id), {
      ...model,
      id,
      providerId,
      displayName: model.displayName ?? id,
    });
  }

  /**
   * Catalogue lookup. `undefined` means "not catalogued" — not "does not
   * exist": the user may still type this id and have it work, because the
   * provider, not the registry, decides which model names are valid.
   */
  resolve(ref: ModelRef): ModelDescriptor | undefined {
    return this.models.get(modelKey(ref.providerId, ref.modelId));
  }

  /**
   * Providers the user can actually call right now: a stored key, or a
   * provider that needs no key. Failures on one provider do not hide the rest.
   */
  async configured(secrets: SecretLike): Promise<string[]> {
    const out: string[] = [];
    for (const provider of BUILTIN_PROVIDERS) {
      if (!provider.requiresApiKey) {
        out.push(provider.id);
        continue;
      }
      try {
        const has = await secrets.exists({ providerId: provider.id, key: provider.secretKey });
        if (has) out.push(provider.id);
      } catch (error) {
        this.logger.warn('could not read provider credential state', {
          providerId: provider.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return out;
  }
}
