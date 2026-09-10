import { eq, and, asc } from 'drizzle-orm';
import { BUILTIN_PROVIDERS, isReasoningEffort, type ProviderOverrides, type ReasoningEffort } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { modelMappings } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { ModelCatalog } from './model-catalog.js';

export interface ResolvedRoute {
  provider: string;
  actualModel: string;
  reasoningEffort?: ReasoningEffort;
  providerOverrides?: ProviderOverrides;
  // null inherits global default; boolean sets explicitly.
  includeReasoning?: boolean | null;
  // Non-standard backend field passthrough (HTTP providers only).
  extraBody?: Record<string, unknown>;
}

function parseProviderOverrides(raw: string | null | undefined): ProviderOverrides | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProviderOverrides;
    }
  } catch (e) {
    console.warn('[router] failed to parse provider_overrides:', (e as Error).message);
  }
  return undefined;
}

function parseExtraBody(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[router] failed to parse extra_body:', (e as Error).message);
  }
  return undefined;
}

export class ModelRouter {
  private registry: ProviderRegistry;
  private catalog?: ModelCatalog;

  constructor(registry: ProviderRegistry, catalog?: ModelCatalog) {
    this.registry = registry;
    this.catalog = catalog;
  }

  async resolve(modelAlias: string): Promise<ResolvedRoute[]> {
    const db = getDatabase();

    const mappings = await db
      .select()
      .from(modelMappings)
      .where(and(
        eq(modelMappings.alias, modelAlias),
        eq(modelMappings.enabled, true),
      ))
      .orderBy(asc(modelMappings.priority));

    const enabledRoutes = mappings
      .filter((m) => (
        this.registry.has(m.provider)
        && this.registry.getProviderConfig(m.provider)?.enabled !== false
      ))
      .map((m) => ({
        provider: m.provider,
        actualModel: m.actualModel,
        reasoningEffort: isReasoningEffort(m.reasoningEffort) ? m.reasoningEffort : undefined,
        providerOverrides: parseProviderOverrides(m.providerOverrides),
        includeReasoning: typeof m.includeReasoning === 'boolean' ? m.includeReasoning : null,
        extraBody: parseExtraBody(m.extraBody),
      }));

    if (enabledRoutes.length > 0) {
      return enabledRoutes;
    }

    // Check ModelCatalog if no active mapping was found in the database.
    if (this.catalog) {
      const catalogModel = await this.catalog.getModel(modelAlias);
      if (
        catalogModel
        && this.registry.has(catalogModel.provider)
        && this.registry.getProviderConfig(catalogModel.provider)?.enabled !== false
      ) {
        return [{
          provider: catalogModel.provider,
          actualModel: catalogModel.actualModel,
          reasoningEffort: catalogModel.reasoningEffort,
        }];
      }
    }

    const inferredProvider = this.inferProvider(modelAlias);
    if (inferredProvider && this.registry.has(inferredProvider) && this.registry.getProviderConfig(inferredProvider)?.enabled !== false) {
      return [{ provider: inferredProvider, actualModel: modelAlias }];
    }
    return [];
  }

  // Infer provider by prefix; strictly match official prefixes to prevent false positives on custom aliases.
  private inferProvider(model: string): string | null {
    const lower = model.toLowerCase();

    if (/^(claude|claude-|sonnet-|opus-|haiku-)/.test(lower)) {
      return 'claude';
    }
    if (/^(gpt-|o1-|o3-|o4-|codex-)/.test(lower)) {
      return 'codex';
    }
    if (/^gemini-/.test(lower)) {
      return 'gemini';
    }
    if (/^(antigravity|agy)(-|$)/.test(lower)) {
      return 'agy';
    }
    if (/^grok(-|$)/.test(lower)) {
      return 'grok';
    }
    if (/^kimi(?:-|\/|$)/.test(lower)) {
      return 'kimi';
    }
    if (/^(opencode|opencodex)(?:-|\/|$)/.test(lower)) {
      return 'opencode';
    }
    return null;
  }
}
