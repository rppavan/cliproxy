import { like } from 'drizzle-orm';
import type { GenericCliProviderConfig } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { QueueManager } from '../services/queue.js';
import { GenericCliProvider } from './generic-cli-provider.js';

const GENERIC_PROVIDER_PREFIX = 'generic_provider:';

interface LoaderLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface LoadResult {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
}

export async function loadGenericProviders(
  registry: ProviderRegistry,
  queueManager: QueueManager,
  logger?: LoaderLogger,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };

  let rows: Array<{ key: string; value: string }>;
  try {
    const db = getDatabase();
    rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${GENERIC_PROVIDER_PREFIX}%`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(`[generic-provider-loader] DB 조회 실패: ${message}`);
    return result;
  }

  for (const row of rows) {
    const name = row.key.replace(GENERIC_PROVIDER_PREFIX, '');

    let config: GenericCliProviderConfig;
    try {
      config = JSON.parse(row.value) as GenericCliProviderConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[generic-provider-loader] "${name}" 설정 파싱 실패: ${message}`);
      result.failed.push({ name, error: `Config parse error: ${message}` });
      continue;
    }

    if (config.enabled === false) {
      logger?.info(`[generic-provider-loader] "${name}" 비활성화됨, 건너뜀`);
      continue;
    }

    if (registry.has(name)) {
      logger?.warn(`[generic-provider-loader] "${name}" 이미 등록됨, 건너뜀`);
      continue;
    }

    try {
      const provider = new GenericCliProvider(name, config);
      registry.register(provider);
      queueManager.addQueue(name, config.max_concurrent);

      logger?.info(`[generic-provider-loader] "${name}" 로드 완료 (cli_path: ${config.cli_path})`);
      result.loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[generic-provider-loader] "${name}" 등록 실패: ${message}`);
      result.failed.push({ name, error: message });
    }
  }

  if (result.loaded.length > 0) {
    logger?.info(
      `[generic-provider-loader] 총 ${result.loaded.length}개 제네릭 프로바이더 로드 완료: ${result.loaded.join(', ')}`,
    );
  }

  if (result.failed.length > 0) {
    logger?.warn(
      `[generic-provider-loader] ${result.failed.length}개 실패: ${result.failed.map((f) => f.name).join(', ')}`,
    );
  }

  return result;
}
