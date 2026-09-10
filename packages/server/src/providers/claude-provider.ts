import type { ChatResponseFormat, ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider, type ProviderModelInfo } from './base-provider.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireStructuredOutput, schemaArgument, shouldBufferStream, wantsSchemaEnforcement } from './structured-output.js';
import { convertMessages } from '../utils/message-converter.js';
import { executeSdk, executeStreamSdk, type SdkExecutorConfig, type SdkMeta } from './claude-sdk-executor.js';
import { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';
import { executeChannel, executeStreamChannel, type ChannelExecutorConfig } from './claude-channel-executor.js';
import { mergeProviderConfig } from './provider-override.js';
import { channelBridgeManager } from '../channel-bridge/manager.js';

// channel-worker health check: verify bridge /health endpoint to ensure it can process requests
async function pingBridgeHealth(baseUrl: string, apiKey?: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/health`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude' as const;

  // SDK mode session manager (lazy initialization)
  private sessionManager: ClaudeSdkSessionManager | null = null;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();

    if (this.isSDKMode) {
      const ttl = config.sdk_options?.session_ttl_ms;
      this.sessionManager = new ClaudeSdkSessionManager(ttl);
    }
  }

  private get isSDKMode(): boolean {
    return this.config.mode === 'sdk';
  }

  private getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    return mergeProviderConfig(this.config, options.providerOverrides, 'claude');
  }

  private ensureSdkSessionManager(ttlMs?: number): ClaudeSdkSessionManager {
    if (!this.sessionManager) {
      this.sessionManager = new ClaudeSdkSessionManager(ttlMs);
    }
    return this.sessionManager;
  }

  private buildSdkConfig(
    options: ExecuteOptions,
    effective: ProviderConfigYaml,
    clientKey?: string,
  ): SdkExecutorConfig {
    return {
      model: options.model || effective.default_model,
      sdkOptions: effective.sdk_options ?? {},
      workingDir: effective.working_dir ?? this.workingDir,
      timeoutMs: effective.timeout_ms,
      cleanEnv: this.getCleanEnv(),
      cliPath: effective.cli_path,
      sessionManager: this.ensureSdkSessionManager(effective.sdk_options?.session_ttl_ms),
      clientKey,
    };
  }

  private buildChannelConfig(options: ExecuteOptions, effective: ProviderConfigYaml): ChannelExecutorConfig {
    const channelOptions = { ...(effective.channel_options ?? {}) };
    // For managed bridge without explicit endpoint_url, derive from bridge_port
    if (!channelOptions.endpoint_url && channelOptions.managed) {
      channelOptions.endpoint_url = `http://127.0.0.1:${channelOptions.bridge_port ?? 8788}`;
    }
    return {
      model: options.model || effective.default_model,
      channelOptions,
      timeoutMs: effective.timeout_ms,
    };
  }

  // --- CLI mode methods ---

  protected override getStdinData(options: ExecuteOptions): string {
    const { userPrompt } = convertMessages(options.messages);
    return userPrompt;
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const effective = this.getEffectiveConfig(options);
    const { systemPrompt } = convertMessages(options.messages);
    const model = options.model || effective.default_model;

    // non-streaming: json, streaming: stream-json --verbose
    // stream-json requires --verbose per Claude CLI specifications
    const format = options.stream ? 'stream-json' : 'json';
    const args: string[] = [
      '-p', '-', // Read prompt from stdin to avoid ARG_MAX limits
      '--output-format', format,
      '--model', model,
      '--max-turns', '50',
    ];

    if (options.stream) {
      args.push('--verbose');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // Claude CLI does not support --max-tokens (API-only option)

    // Inject reasoning effort unless explicitly provided in extra_args
    if (options.reasoningEffort && !effective.extra_args.includes('--effort')) {
      args.push('--effort', options.reasoningEffort);
    }

    // Pass response_format.json_schema to claude --json-schema unless user pinned schema via extra_args
    const schemaArg = schemaArgument(options.chatResponseFormat);
    const userHasSchema = effective.extra_args.some(
      (arg) => arg === '--json-schema' || arg.startsWith('--json-schema='),
    );
    if (schemaArg && !userHasSchema) {
      args.push('--json-schema', schemaArg);
    }

    args.push(...effective.extra_args);

    return args;
  }

  // Only CLI mode supports --json-schema directly; sdk/channel-worker use separate executors.
  override supportsResponseFormat(format: ChatResponseFormat): boolean {
    if (format.type !== 'json_schema') return false;
    return this.config.mode !== 'sdk' && this.config.mode !== 'channel-worker';
  }

  protected override parseNonStreamOutput(stdout: string, options?: ExecuteOptions): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    // Wrap only JSON parsing in try/catch so schema validation errors throw directly
    // rather than incorrectly falling back to plain text.
    let data: Record<string, unknown> & { usage?: Record<string, number> };
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Fall back to plain text on JSON parse failure
      return {
        content: trimmed,
        usage: { promptTokens: 0, completionTokens: Math.ceil(trimmed.length / 4), totalTokens: Math.ceil(trimmed.length / 4) },
        finishReason: 'stop',
      };
    }

    // When schema is requested, use structured_output as the canonical output
    // rather than result text (Claude CLI populates structured_output via an internal tool).
    const content = wantsSchemaEnforcement(options?.chatResponseFormat)
      ? requireStructuredOutput(data.structured_output, 'claude', 'structured_output')
      : (data.result as string | undefined) ?? '';
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const cacheRead = data.usage?.cache_read_input_tokens ?? 0;
    const cacheCreate = data.usage?.cache_creation_input_tokens ?? 0;

    return {
      content,
      usage: {
        promptTokens: inputTokens + cacheRead + cacheCreate,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
      },
      finishReason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
    };
  }

  private sdkDebugArgs(model: string, meta?: SdkMeta): string[] {
    const args = ['[sdk-mode]', `model=${model}`];
    if (meta) {
      args.push(`session=${meta.sessionId ?? 'none'}`);
      args.push(`reused=${meta.sessionReused}`);
      if (meta.retried) args.push('retried=true');
    }
    return args;
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const effective = this.getEffectiveConfig(options);
    if (effective.mode === 'sdk') {
      const result = await executeSdk(options, this.buildSdkConfig(options, effective, options.clientKey));
      const model = options.model || effective.default_model;
      // Invoke onDebug callback in SDK mode to prevent debug log from remaining PENDING
      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, result.sdkMeta),
        stdout: result.content,
      });
      return result;
    }
    if (effective.mode === 'channel-worker') {
      return executeChannel(options, this.buildChannelConfig(options, effective));
    }
    return super.execute(options);
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const effective = this.getEffectiveConfig(options);

    // Emit schema requests as a single completed structured output (Claude CLI streams prose
    // deltas and only populates the schema-conforming value in the final result).
    if (shouldBufferStream(options.chatResponseFormat) && effective.mode !== 'sdk' && effective.mode !== 'channel-worker') {
      const result = await this.execute({ ...options, stream: false });
      yield { type: 'text_delta', text: result.content };
      yield { type: 'usage', usage: result.usage };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    if (effective.mode === 'sdk') {
      const sdkLines: string[] = [];
      let streamMeta: SdkMeta | undefined;
      const sdkConfig = this.buildSdkConfig(options, effective, options.clientKey);
      sdkConfig.onSdkMeta = (meta) => { streamMeta = meta; };

      for await (const event of executeStreamSdk(options, sdkConfig)) {
        if (event.type === 'text_delta') {
          sdkLines.push(event.text);
        }
        yield event;
      }
      const model = options.model || effective.default_model;
      // Invoke onDebug callback in SDK mode to prevent debug log from remaining PENDING
      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, streamMeta),
        streamLines: sdkLines,
      });
      return;
    }
    if (effective.mode === 'channel-worker') {
      yield* executeStreamChannel(options, this.buildChannelConfig(options, effective));
      return;
    }
    yield* super.executeStream(options);
  }

  override async checkHealth(): Promise<HealthStatus> {
    // In channel-worker mode, check bridge availability rather than local CLI binary presence
    if (this.config.mode === 'channel-worker') {
      const ch = this.config.channel_options ?? {};
      if (ch.managed) {
        // Managed bridge: check running and healthy status of managed process
        const status = await channelBridgeManager.status();
        return status.running && status.healthy ? 'healthy' : 'unhealthy';
      }
      // External bridge: ping /health endpoint
      const baseUrl = ch.endpoint_url ?? `http://127.0.0.1:${ch.bridge_port ?? 8788}`;
      return (await pingBridgeHealth(baseUrl, ch.api_key)) ? 'healthy' : 'unhealthy';
    }
    // CLI / SDK mode: check CLI binary existence (SDK spawns CLI internally)
    return super.checkHealth();
  }

  // Reinitialize session manager on runtime config change
  override updateConfig(partial: Partial<ProviderConfigYaml>): void {
    const wasSDKMode = this.isSDKMode;
    super.updateConfig(partial);

    // Instantiate session manager when transitioning to SDK mode
    if (!wasSDKMode && this.isSDKMode && !this.sessionManager) {
      const ttl = this.config.sdk_options?.session_ttl_ms;
      this.sessionManager = new ClaudeSdkSessionManager(ttl);
    }

    // Destroy session manager when transitioning away from SDK mode
    if (wasSDKMode && !this.isSDKMode && this.sessionManager) {
      this.sessionManager.destroy();
      this.sessionManager = null;
    }
  }

  override async listModels(): Promise<ProviderModelInfo[]> {
    const models: ProviderModelInfo[] = [];
    const seen = new Set<string>();

    // 1. Check ~/.claude/settings.json
    try {
      const home = process.env.CLAUDE_CONFIG_DIR || process.env.HOME;
      if (home) {
        const settingsPath = join(home, home.endsWith('.claude') ? 'settings.json' : '.claude/settings.json');
        const raw = await readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.model && typeof parsed.model === 'string') {
          const id = parsed.model.replace(/\[.*?\]/, '').trim();
          if (id && !seen.has(id)) {
            seen.add(id);
            models.push({ id, name: id });
          }
        }
        if (parsed.modelSettings && typeof parsed.modelSettings === 'object') {
          for (const key of Object.keys(parsed.modelSettings)) {
            if (key && !seen.has(key)) {
              seen.add(key);
              models.push({ id: key, name: key });
            }
          }
        }
      }
    } catch { /* ignore error reading settings */ }

    // 2. Add officially supported Claude Code models
    const standardModels = [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'sonnet',
      'opus',
      'haiku',
    ];
    for (const m of standardModels) {
      if (!seen.has(m)) {
        seen.add(m);
        models.push({ id: m, name: m });
      }
    }

    const defaultModel = this.config.default_model;
    if (defaultModel && !seen.has(defaultModel)) {
      models.unshift({ id: defaultModel, name: defaultModel });
    }

    return models;
  }
}
