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
  private cacheTtlMs = 60_000; // 60초 캐시

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  // 캐시 수동 무효화 (매핑 변경/프로바이더 변경 시)
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * 활성화된 프로바이더의 실시간 CLI 모델 목록 및 상단에 별칭(alias) 매핑을 병합하여 반환.
   * 비활성화된 프로바이더의 모델 및 별칭은 모두 제외된다.
   */
  async getModels(): Promise<CatalogModel[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.models;
    }

    const db = getDatabase();

    // 1. 현재 활성화된 프로바이더 식별
    const activeProviders = this.registry.getAll().filter((p) => {
      return this.registry.getProviderConfig(p.name)?.enabled !== false;
    });
    const enabledProviderNames = new Set(activeProviders.map((p) => p.name));

    // 2. DB에서 활성 프로바이더에 해당하는 별칭(alias) 매핑 조회
    const allDbMappings = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.enabled, true))
      .orderBy(asc(modelMappings.priority));

    // 비활성화된 프로바이더는 필터링
    const enabledDbMappings = allDbMappings.filter((m) => enabledProviderNames.has(m.provider));

    // 3. 활성 프로바이더들로부터 실제 CLI 모델 목록 병렬 조회
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

    // 4. 별칭(alias)들을 목록 최상단(Top)에 먼저 배치
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

    // 5. 활성 프로바이더의 실제 CLI 모델들을 그 뒤에 추가 (이미 별칭으로 등록된 ID는 중복 방지)
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
