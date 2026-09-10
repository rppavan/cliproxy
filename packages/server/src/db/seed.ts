import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig } from '@star-cliproxy/shared';
import { getDatabase } from './client.js';
import { apiKeys, modelMappings, settings } from './schema.js';
import { hashApiKey, getKeyPrefix } from '../middleware/auth.js';

const CLI_MODEL_MIGRATION_KEY = 'migration.cli-model-catalog-2026-07';
const KIMI_CATALOG_MIGRATION_KEY = 'migration.kimi-provider-catalog-2026-07';
const OPENCODE_CATALOG_MIGRATION_KEY = 'migration.opencode-provider-catalog-2026-09';
const MAX_AUTOMATIC_MAPPINGS_PER_PROVIDER = 2;

interface SeedMapping {
  alias: string;
  provider: string;
  actual_model: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

const CURRENT_CATALOG_ADDITIONS: SeedMapping[] = [
  { alias: 'antigravity', provider: 'agy', actual_model: 'antigravity' },
  { alias: 'gemini-3.6-flash-high', provider: 'agy', actual_model: 'gemini-3.6-flash', reasoning_effort: 'high' },
  { alias: 'grok-4.5', provider: 'grok', actual_model: 'grok-4.5' },
];

const KIMI_CATALOG_ADDITIONS: SeedMapping[] = [
  { alias: 'kimi-k3', provider: 'kimi', actual_model: 'kimi-code/k3' },
  { alias: 'kimi-coding', provider: 'kimi', actual_model: 'kimi-code/kimi-for-coding' },
];

const OPENCODE_CATALOG_ADDITIONS: SeedMapping[] = [
  { alias: 'opencode-free', provider: 'opencode', actual_model: 'opencode/muse-spark-1.3-contributor-free' },
];

async function insertAutomaticCatalogMappings(
  mappings: SeedMapping[],
  now: string,
): Promise<void> {
  const db = getDatabase();
  const existing = await db
    .select({
      alias: modelMappings.alias,
      provider: modelMappings.provider,
      enabled: modelMappings.enabled,
    })
    .from(modelMappings);
  const aliases = new Set(existing.map((mapping) => mapping.alias));
  const enabledCounts = new Map<string, number>();

  for (const mapping of existing) {
    if (!mapping.enabled) continue;
    enabledCounts.set(mapping.provider, (enabledCounts.get(mapping.provider) ?? 0) + 1);
  }

  for (const mapping of mappings) {
    if (
      aliases.has(mapping.alias)
      || (enabledCounts.get(mapping.provider) ?? 0) >= MAX_AUTOMATIC_MAPPINGS_PER_PROVIDER
    ) {
      continue;
    }

    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: mapping.alias,
      provider: mapping.provider,
      actualModel: mapping.actual_model,
      displayName: mapping.alias,
      reasoningEffort: mapping.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    aliases.add(mapping.alias);
    enabledCounts.set(mapping.provider, (enabledCounts.get(mapping.provider) ?? 0) + 1);
  }
}

function normalizeLegacyBuiltinMapping(mapping: SeedMapping): SeedMapping | null {
  if (mapping.provider === 'grok') {
    if (mapping.actual_model === 'grok-composer-2.5-fast') return null;
    if (mapping.actual_model === 'grok-build') {
      return { ...mapping, actual_model: 'grok-4.5' };
    }
  }

  const agyLegacy: Record<string, { model: string; effort: 'low' | 'medium' | 'high' }> = {
    'Gemini 3.5 Flash (Low)': { model: 'gemini-3.5-flash', effort: 'low' },
    'Gemini 3.5 Flash (Medium)': { model: 'gemini-3.5-flash', effort: 'medium' },
    'Gemini 3.5 Flash (High)': { model: 'gemini-3.5-flash', effort: 'high' },
    'Gemini 3.1 Pro (Low)': { model: 'gemini-3.1-pro', effort: 'low' },
    'Gemini 3.1 Pro (High)': { model: 'gemini-3.1-pro', effort: 'high' },
  };
  if (mapping.provider === 'agy' && agyLegacy[mapping.actual_model]) {
    const replacement = agyLegacy[mapping.actual_model];
    return {
      ...mapping,
      actual_model: replacement.model,
      reasoning_effort: replacement.effort,
    };
  }

  return mapping;
}

async function migrateBuiltinCliMappings(): Promise<void> {
  const db = getDatabase();
  const alreadyApplied = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, CLI_MODEL_MIGRATION_KEY))
    .limit(1);
  if (alreadyApplied.length > 0) return;

  const now = new Date().toISOString();
  const legacyUpdates: Array<{
    alias: string;
    provider: string;
    fromModel: string;
    toModel: string;
    effort?: 'low' | 'medium' | 'high';
  }> = [
    { alias: 'grok-build', provider: 'grok', fromModel: 'grok-build', toModel: 'grok-4.5' },
    { alias: 'grok-build-high', provider: 'grok', fromModel: 'grok-build', toModel: 'grok-4.5', effort: 'high' },
    { alias: 'gemini-3.5-flash-low', provider: 'agy', fromModel: 'Gemini 3.5 Flash (Low)', toModel: 'gemini-3.5-flash', effort: 'low' },
    { alias: 'gemini-3.5-flash-medium', provider: 'agy', fromModel: 'Gemini 3.5 Flash (Medium)', toModel: 'gemini-3.5-flash', effort: 'medium' },
    { alias: 'gemini-3.5-flash-high', provider: 'agy', fromModel: 'Gemini 3.5 Flash (High)', toModel: 'gemini-3.5-flash', effort: 'high' },
    { alias: 'gemini-3.1-pro-low', provider: 'agy', fromModel: 'Gemini 3.1 Pro (Low)', toModel: 'gemini-3.1-pro', effort: 'low' },
    { alias: 'gemini-3.1-pro-high', provider: 'agy', fromModel: 'Gemini 3.1 Pro (High)', toModel: 'gemini-3.1-pro', effort: 'high' },
  ];

  for (const migration of legacyUpdates) {
    await db
      .update(modelMappings)
      .set({
        actualModel: migration.toModel,
        ...(migration.effort ? { reasoningEffort: migration.effort } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(modelMappings.alias, migration.alias),
        eq(modelMappings.provider, migration.provider),
        eq(modelMappings.actualModel, migration.fromModel),
      ));
  }

  // Disable only the removed Composer default mapping, leaving user-modified models intact.
  await db
    .update(modelMappings)
    .set({ enabled: false, updatedAt: now })
    .where(and(
      eq(modelMappings.alias, 'grok-composer'),
      eq(modelMappings.provider, 'grok'),
      eq(modelMappings.actualModel, 'grok-composer-2.5-fast'),
    ));

  await insertAutomaticCatalogMappings(CURRENT_CATALOG_ADDITIONS, now);

  await db.insert(settings).values({
    key: CLI_MODEL_MIGRATION_KEY,
    value: now,
    updatedAt: now,
  });
}

async function seedKimiCatalog(): Promise<void> {
  const db = getDatabase();
  const alreadyApplied = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, KIMI_CATALOG_MIGRATION_KEY))
    .limit(1);
  if (alreadyApplied.length > 0) return;

  const now = new Date().toISOString();
  await insertAutomaticCatalogMappings(KIMI_CATALOG_ADDITIONS, now);

  await db.insert(settings).values({
    key: KIMI_CATALOG_MIGRATION_KEY,
    value: now,
    updatedAt: now,
  });
}

async function seedOpencodeCatalog(): Promise<void> {
  const db = getDatabase();
  const alreadyApplied = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, OPENCODE_CATALOG_MIGRATION_KEY))
    .limit(1);
  if (alreadyApplied.length > 0) return;

  const now = new Date().toISOString();
  await insertAutomaticCatalogMappings(OPENCODE_CATALOG_ADDITIONS, now);

  await db.insert(settings).values({
    key: OPENCODE_CATALOG_MIGRATION_KEY,
    value: now,
    updatedAt: now,
  });
}

export async function seedDatabase(config: AppConfig): Promise<void> {
  const db = getDatabase();

  for (const keyConfig of config.auth.initialKeys) {
    if (!keyConfig.key) continue;

    const keyHash = hashApiKey(keyConfig.key);
    const existing = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(apiKeys).values({
        id: nanoid(),
        keyHash,
        keyPrefix: getKeyPrefix(keyConfig.key),
        name: keyConfig.name,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Seed model mappings additively: only add aliases from config.yaml that are missing in the DB.
  // Never overwrite existing mappings; the DB is the runtime SSOT and clobbering dashboard edits on restart would be a regression (#38).
  await migrateBuiltinCliMappings();
  await seedKimiCatalog();
  await seedOpencodeCatalog();

  const existingMappings = await db
    .select({ alias: modelMappings.alias })
    .from(modelMappings);
  const existingAliases = new Set(existingMappings.map((m) => m.alias));

  for (const mapping of config.modelMappings) {
    const normalized = normalizeLegacyBuiltinMapping(mapping as SeedMapping);
    if (!normalized || existingAliases.has(normalized.alias)) continue;
    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: normalized.alias,
      provider: normalized.provider,
      actualModel: normalized.actual_model,
      displayName: normalized.alias,
      reasoningEffort: normalized.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}
