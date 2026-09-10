import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  PluginEntry,
  CliproxyPlugin,
  ProviderConfigYaml,
  PluginProviderConfig,
} from '@star-cliproxy/shared';
import { DEFAULT_MAX_CONCURRENT, DEFAULT_TIMEOUT_MS } from '@star-cliproxy/shared';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { BaseProvider } from '../providers/base-provider.js';
import { registerParser } from '../utils/stream-transformer.js';

// Adapts CliproxyPluginProvider to the internal BaseProvider interface.
class PluginProviderAdapter {
  readonly name: string;
  readonly endpointTypes;
  private inner: ReturnType<CliproxyPlugin['createProvider']>;
  private config: ProviderConfigYaml;

  constructor(
    plugin: CliproxyPlugin,
    inner: ReturnType<CliproxyPlugin['createProvider']>,
    config: ProviderConfigYaml,
  ) {
    this.name = plugin.name;
    this.endpointTypes = plugin.endpointTypes;
    this.inner = inner;
    this.config = config;
  }

  get maxConcurrent() { return this.config.max_concurrent; }
  get timeoutMs() { return this.config.timeout_ms; }

  async execute(options: Parameters<BaseProvider['execute']>[0]) {
    return this.inner.execute(options);
  }

  async *executeStream(options: Parameters<BaseProvider['execute']>[0]) {
    if (this.inner.executeStream) {
      yield* this.inner.executeStream(options);
    } else {
      // Fall back to non-streaming execution when executeStream is not implemented.
      const result = await this.inner.execute(options);
      yield { type: 'delta' as const, content: result.content };
      yield { type: 'done' as const, usage: result.usage };
    }
  }

  async checkHealth() {
    return this.inner.checkHealth();
  }

  updateConfig(partial: Partial<ProviderConfigYaml>): void {
    Object.assign(this.config, partial);
  }

  getConfig(): ProviderConfigYaml {
    return { ...this.config };
  }
}

function validatePlugin(mod: unknown, pluginPath: string): CliproxyPlugin {
  const plugin = mod as Record<string, unknown>;

  const candidate = (plugin.default ?? plugin) as Record<string, unknown>;

  if (typeof candidate.name !== 'string' || !candidate.name) {
    throw new Error(`Plugin at "${pluginPath}" must export a "name" string.`);
  }
  if (!Array.isArray(candidate.endpointTypes) || candidate.endpointTypes.length === 0) {
    throw new Error(`Plugin "${candidate.name}" must export "endpointTypes" array (e.g. ['chat'], ['images']).`);
  }
  if (typeof candidate.createProvider !== 'function') {
    throw new Error(`Plugin "${candidate.name}" must export a "createProvider" function.`);
  }

  return candidate as unknown as CliproxyPlugin;
}

function buildPluginConfig(entry: PluginEntry): ProviderConfigYaml {
  const c = entry.config ?? {};
  return {
    enabled: c.enabled ?? true,
    cli_path: c.cli_path ?? '',
    default_model: c.default_model ?? '',
    max_concurrent: c.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
    timeout_ms: c.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    extra_args: c.extra_args ?? [],
  };
}

export interface PluginLoadResult {
  loaded: string[];
  failed: Array<{ path: string; error: string }>;
}

export async function loadPlugins(
  entries: PluginEntry[],
  registry: ProviderRegistry,
  logger?: { warn: (msg: string) => void; info: (msg: string) => void },
  baseDir?: string,
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], failed: [] };
  const base = baseDir ?? process.cwd();

  for (const entry of entries) {
    if (!entry.path) {
      result.failed.push({ path: '(empty)', error: 'Plugin path is empty.' });
      continue;
    }

    const pluginDir = resolve(base, entry.path);

    if (!existsSync(pluginDir)) {
      const msg = `Plugin directory not found: "${pluginDir}"`;
      logger?.warn(msg);
      result.failed.push({ path: entry.path, error: msg });
      continue;
    }

    try {
      // Use pathToFileURL for Windows and ESM dynamic import compatibility.
      const entryPoint = resolve(pluginDir, 'index.js');
      if (!existsSync(entryPoint)) {
        throw new Error(`Plugin entry point not found: "${entryPoint}". Ensure the plugin is built.`);
      }

      const mod = await import(pathToFileURL(entryPoint).href);
      const plugin = validatePlugin(mod, entry.path);

      if (registry.has(plugin.name)) {
        throw new Error(`Provider name "${plugin.name}" conflicts with an existing provider.`);
      }

      const config = buildPluginConfig(entry);
      const pluginConfig: PluginProviderConfig = { ...config, ...(entry.config ?? {}) };
      const inner = plugin.createProvider(pluginConfig);
      const adapter = new PluginProviderAdapter(plugin, inner, config);

      registry.register(adapter as unknown as import('../providers/base-provider.js').BaseProvider);

      if (plugin.createParser) {
        registerParser(plugin.name, () => plugin.createParser!());
      }

      logger?.info(`Plugin loaded: "${plugin.name}" (endpoints: ${plugin.endpointTypes.join(', ')})`);
      result.loaded.push(plugin.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(`Failed to load plugin at "${entry.path}": ${msg}`);
      result.failed.push({ path: entry.path, error: msg });
    }
  }

  return result;
}
