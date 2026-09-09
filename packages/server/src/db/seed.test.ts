import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/loader.js';
import { closeDatabase, getDatabase, initDatabase } from './client.js';
import { modelMappings, settings } from './schema.js';
import { seedDatabase } from './seed.js';

describe.sequential('seedDatabase CLI model catalog migration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'star-cliproxy-seed-test-'));
    await initDatabase(join(tempDir, 'cliproxy.db'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('기존 builtin 매핑만 최신 slug로 전환하고 사용자 정의 매핑은 보존', async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    await db.insert(modelMappings).values([
      {
        id: 'legacy-grok',
        alias: 'grok-build',
        provider: 'grok',
        actualModel: 'grok-build',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'legacy-composer',
        alias: 'grok-composer',
        provider: 'grok',
        actualModel: 'grok-composer-2.5-fast',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'legacy-agy',
        alias: 'gemini-3.5-flash-high',
        provider: 'agy',
        actualModel: 'Gemini 3.5 Flash (High)',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'custom',
        alias: 'my-grok',
        provider: 'grok',
        actualModel: 'grok-build',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const config = loadConfig(join(tempDir, 'missing-config.yaml'));
    await seedDatabase(config);
    // 재시작 시에도 migration/catalog row가 중복되지 않아야 한다.
    await seedDatabase(config);

    const rows = await db.select().from(modelMappings);
    const byAlias = new Map(rows.map((row) => [row.alias, row]));

    expect(byAlias.get('grok-build')?.actualModel).toBe('grok-4.5');
    expect(byAlias.get('grok-composer')?.enabled).toBe(false);
    expect(byAlias.get('gemini-3.5-flash-high')).toMatchObject({
      actualModel: 'gemini-3.5-flash',
      reasoningEffort: 'high',
    });
    expect(byAlias.get('my-grok')?.actualModel).toBe('grok-build');

    expect(byAlias.get('antigravity')).toMatchObject({
      provider: 'agy',
      actualModel: 'antigravity',
    });
    expect(byAlias.get('grok-4.5')?.actualModel).toBe('grok-4.5');
    expect(rows.filter((row) => row.alias === 'grok-4.5')).toHaveLength(1);
    expect(byAlias.get('kimi-coding')).toMatchObject({
      provider: 'kimi',
      actualModel: 'kimi-code/kimi-for-coding',
    });
    expect(byAlias.get('kimi-k3')).toMatchObject({
      provider: 'kimi',
      actualModel: 'kimi-code/k3',
    });
    expect(byAlias.has('kimi-k3-max')).toBe(false);
    expect(byAlias.has('kimi-k3-256k')).toBe(false);
    expect(rows.filter((row) => row.alias === 'kimi-k3')).toHaveLength(1);

    const migration = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'migration.cli-model-catalog-2026-07'));
    expect(migration).toHaveLength(1);

    const kimiMigration = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'migration.kimi-provider-catalog-2026-07'));
    expect(kimiMigration).toHaveLength(1);
  });

  it('새 설치의 자동 모델 매핑은 프로바이더당 최대 2개만 등록', async () => {
    const db = getDatabase();
    const config = loadConfig(join(tempDir, 'missing-config.yaml'));

    await seedDatabase(config);
    // 다음 시작에서도 catalog migration이 다시 모델을 늘리지 않아야 한다.
    await seedDatabase(config);

    const rows = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.enabled, true));
    const aliasesByProvider = new Map<string, string[]>();

    for (const row of rows) {
      const aliases = aliasesByProvider.get(row.provider) ?? [];
      aliases.push(row.alias);
      aliasesByProvider.set(row.provider, aliases);
    }

    expect(
      Array.from(aliasesByProvider.entries())
        .filter(([, aliases]) => aliases.length > 2),
    ).toEqual([]);
    expect(aliasesByProvider.get('agy')?.sort()).toEqual([
      'antigravity',
      'gemini-3.6-flash-high',
    ]);
    expect(aliasesByProvider.get('grok')).toEqual(['grok-4.5']);
    expect(aliasesByProvider.get('kimi')?.sort()).toEqual([
      'kimi-coding',
      'kimi-k3',
    ]);
    expect(aliasesByProvider.get('opencode')).toEqual(['opencode-free']);
  });
});
