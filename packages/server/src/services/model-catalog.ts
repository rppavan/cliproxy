import { eq, asc } from 'drizzle-orm';
import { isReasoningEffort, type ReasoningEffort } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { modelMappings } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

export interface CatalogModel {
  id: string;
  alias: string;
  provider: string;
  actualModel: string;
  displayName: string;
  isAlias: boolean;
  enabled: boolean;
  reasoningEffort?: ReasoningEffort;
  priority?: number;
  ownedBy: string;
}

export class ModelCatalog {
  private registry: ProviderRegistry;
  private cache: { models: CatalogModel[]; expiresAt: number } | null = null;
  private cacheTtlMs = 60_000;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Merge and return active provider CLI models with database alias mappings at the top.
   * Models and aliases for disabled providers are excluded.
   */
  async getModels(): Promise<CatalogModel[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.models;
    }

    const db = getDatabase();

    const activeProviders = this.registry.getAll().filter((p) => {
      return this.registry.getProviderConfig(p.name)?.enabled !== false;
    });
    const enabledProviderNames = new Set(activeProviders.map((p) => p.name));

    const allDbMappings = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.enabled, true))
      .orderBy(asc(modelMappings.priority));

    const enabledDbMappings = allDbMappings.filter((m) => enabledProviderNames.has(m.provider));

    const providerModelPromises = activeProviders.map(async (provider) => {
      try {
        const models = await provider.listModels();
        return { provider: provider.name, models };
      } catch (err) {
        console.warn(`[model-catalog] Error listing models for provider ${provider.name}:`, (err as Error).message);
        return { provider: provider.name, models: [] };
      }
    });

    const providerResults = await Promise.all(providerModelPromises);

    const result: CatalogModel[] = [];
    const seenIds = new Set<string>();

    // Place alias mappings first so they take precedence over raw CLI model IDs.
    for (const m of enabledDbMappings) {
      if (!seenIds.has(m.alias)) {
        seenIds.add(m.alias);
        result.push({
          id: m.alias,
          alias: m.alias,
          provider: m.provider,
          actualModel: m.actualModel,
          displayName: m.displayName || m.alias,
          isAlias: true,
          enabled: true,
          reasoningEffort: isReasoningEffort(m.reasoningEffort) ? m.reasoningEffort : undefined,
          priority: m.priority,
          ownedBy: `cliproxy-${m.provider}`,
        });
      }
    }

    for (const { provider, models } of providerResults) {
      for (const model of models) {
        if (!seenIds.has(model.id)) {
          seenIds.add(model.id);
          result.push({
            id: model.id,
            alias: model.id,
            provider,
            actualModel: model.id,
            displayName: model.name || model.id,
            isAlias: false,
            enabled: true,
            ownedBy: `cliproxy-${provider}`,
          });
        }
      }
    }

    this.cache = { models: result, expiresAt: now + this.cacheTtlMs };
    return result;
  }

  async getModel(id: string): Promise<CatalogModel | undefined> {
    const models = await this.getModels();
    return models.find((m) => m.id === id || m.alias === id);
  }
}
