import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { initDatabase, closeDatabase, getDatabase } from '../db/client.js';
import { modelMappings } from '../db/schema.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { BaseProvider, type ProviderModelInfo } from '../providers/base-provider.js';
import { ModelCatalog } from './model-catalog.js';
import { ModelRouter } from './router.js';

class MockProvider extends BaseProvider {
  constructor(
    readonly name: string,
    private mockModels: ProviderModelInfo[],
    enabled = true,
  ) {
    super({
      enabled,
      cli_path: name,
      default_model: mockModels[0]?.id ?? 'default',
      max_concurrent: 5,
      timeout_ms: 10000,
      extra_args: [],
    });
  }

  protected buildArgs(): string[] {
    return [];
  }

  override async listModels(): Promise<ProviderModelInfo[]> {
    return this.mockModels;
  }
}

describe('ModelCatalog and Router Dynamic Model Resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'model-catalog-test-'));
    await initDatabase(join(tempDir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists real models from enabled providers and places aliases on top', async () => {
    const db = getDatabase();
    const now = new Date().toISOString();

    // 1. Insert aliases into DB: one for agy, one for disabled grok
    await db.insert(modelMappings).values([
      {
        id: nanoid(),
        alias: 'my-custom-antigravity',
        provider: 'agy',
        actualModel: 'antigravity',
        displayName: 'Custom Antigravity',
        enabled: true,
        priority: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: nanoid(),
        alias: 'grok-alias',
        provider: 'grok',
        actualModel: 'grok-4.5',
        displayName: 'Disabled Grok Alias',
        enabled: true,
        priority: 2,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 2. Setup registry with agy (enabled) and grok (disabled)
    const registry = new ProviderRegistry();
    const agyProvider = new MockProvider('agy', [
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High' },
      { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash High' },
    ]);
    const grokProvider = new MockProvider(
      'grok',
      [{ id: 'grok-4.5', name: 'Grok 4.5' }],
      false, // disabled
    );

    registry.register(agyProvider);
    registry.register(grokProvider);

    const catalog = new ModelCatalog(registry);
    const models = await catalog.getModels();

    // 3. Verify aliases are on TOP
    expect(models[0].alias).toBe('my-custom-antigravity');
    expect(models[0].isAlias).toBe(true);
    expect(models[0].provider).toBe('agy');

    // 4. Verify real CLI models follow after aliases
    const realModelIds = models.slice(1).map((m) => m.id);
    expect(realModelIds).toContain('gemini-3.8-flash-high');
    expect(realModelIds).toContain('gemini-3.7-flash-high');
    expect(models.find((m) => m.id === 'gemini-3.8-flash-high')?.isAlias).toBe(false);

    // 5. Verify disabled provider (grok) models and aliases are EXCLUDED
    const allProviders = new Set(models.map((m) => m.provider));
    expect(allProviders.has('grok')).toBe(false);
    expect(models.some((m) => m.alias === 'grok-alias')).toBe(false);
    expect(models.some((m) => m.id === 'grok-4.5')).toBe(false);
  });

  it('ModelRouter dynamically routes real CLI models from catalog', async () => {
    const registry = new ProviderRegistry();
    const codexProvider = new MockProvider('codex', [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    ]);
    registry.register(codexProvider);

    const catalog = new ModelCatalog(registry);
    const router = new ModelRouter(registry, catalog);

    // Should resolve gpt-6-astra even without a DB model_mapping
    const routes = await router.resolve('gpt-6-astra');
    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe('codex');
    expect(routes[0].actualModel).toBe('gpt-6-astra');
  });

  it('ModelRouter does not route to disabled providers', async () => {
    const registry = new ProviderRegistry();
    const grokProvider = new MockProvider(
      'grok',
      [{ id: 'grok-4.5', name: 'Grok 4.5' }],
      false, // disabled
    );
    registry.register(grokProvider);

    const catalog = new ModelCatalog(registry);
    const router = new ModelRouter(registry, catalog);

    const routes = await router.resolve('grok-4.5');
    expect(routes).toHaveLength(0);
  });
});
