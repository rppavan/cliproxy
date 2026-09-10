import type { ChatResponseFormat, ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider, type ProviderModelInfo } from './base-provider.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { schemaArgument, shouldBufferStream, wantsSchemaEnforcement } from './structured-output.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { prepareCodexPrompt } from '../utils/image-extractor.js';
import { CodexAppServerProcess, type CodexAppServerProcessConfig } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { executeAppServer, executeStreamAppServer, type AppServerExecutorConfig, type AppServerMeta } from './codex-appserver-executor.js';
import { CodexCliSessionManager } from './codex-cli-session-manager.js';
import { mergeProviderConfig } from './provider-override.js';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CodexExecuteContext {
  text: string;
  imageFiles: string[];
}

interface CodexExecuteOptions extends ExecuteOptions {
  __codexPrompt?: CodexExecuteContext;
  // Codex accepts schemas via file path (--output-schema <path>) rather than inline arguments.
  // execute/executeStream write a temporary file and buildArgs passes its path.
  __codexSchemaPath?: string;
}

// Unsupported flags in 'codex exec resume <id>' based on 'codex exec resume --help'.
// Options taking arguments (-s/--sandbox, -C/--cd, --add-dir, etc.) strip the succeeding token as well.
const RESUME_UNSUPPORTED_FLAGS_WITH_VALUE = new Set([
  '-s', '--sandbox',
  '-C', '--cd',
  '--add-dir',
  '-p', '--profile',
  '--local-provider',
  '--output-schema',
  '--color',
]);
const RESUME_UNSUPPORTED_FLAGS_STANDALONE = new Set([
  '--oss',
]);

// Extracts thread_id from the first line of codex --json output; returns null on invalid input.
// Validates UUID format to defend against injection attacks into SessionManager keys and CLI arguments.
const THREAD_ID_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function extractThreadIdFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed);
    if (!data || data.type !== 'thread.started') return null;
    const candidate = typeof data.thread_id === 'string' ? data.thread_id
      : typeof data.threadId === 'string' ? data.threadId
      : (data.thread && typeof data.thread.id === 'string') ? data.thread.id
      : null;
    if (candidate && THREAD_ID_UUID_RE.test(candidate)) return candidate;
  } catch { /* ignore non-NDJSON line */ }
  return null;
}

export function filterResumeUnsupportedArgs(args: string[]): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) { skipNext = false; continue; }
    // Handle --flag=value format
    const eqIdx = arg.indexOf('=');
    const flagPart = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    if (RESUME_UNSUPPORTED_FLAGS_WITH_VALUE.has(flagPart)) {
      // Skip next token if --flag and value are separated by whitespace
      if (eqIdx < 0) skipNext = true;
      continue;
    }
    if (RESUME_UNSUPPORTED_FLAGS_STANDALONE.has(flagPart)) continue;
    result.push(arg);
  }
  return result;
}

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;

  // App Server mode: process and session manager (lazy initialization)
  private appServerProcess: CodexAppServerProcess | null = null;
  private appServerSessionManager: CodexAppServerSessionManager | null = null;
  // CLI mode (exec resume) session manager: lazily initialized on first call where enable_session_reuse is true
  private cliSessionManager: CodexCliSessionManager | null = null;
  // Deduplication set to log ephemeral auto-override warning once per model alias
  private warnedEphemeralForceAlias = new Set<string>();

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();

    if (this.isAppServerMode) {
      this.initAppServer();
    }
  }

  private get isAppServerMode(): boolean {
    return this.config.mode === 'app-server';
  }

  // Computes effective config for CLI mode with provider overrides applied.
  // If enable_session_reuse is true, forces ephemeral to false (and warns once) because
  // ephemeral=true skips persisting jsonl to disk, causing subsequent exec resume to fail with 'no rollout found'.
  getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    const merged = mergeProviderConfig(this.config, options.providerOverrides, 'codex');
    const cli = merged.cli_options;
    if (cli?.enable_session_reuse === true && cli?.ephemeral !== false) {
      const aliasKey = options.model || this.config.default_model || '<default>';
      if (!this.warnedEphemeralForceAlias.has(aliasKey)) {
        this.warnedEphemeralForceAlias.add(aliasKey);
        const reason = cli.ephemeral === true ? 'explicitly true' : 'defaulting to true';
        console.warn(`[codex] cli_options.ephemeral disabled because enable_session_reuse is true (was ${reason}, model: ${aliasKey})`);
      }
      merged.cli_options = { ...cli, ephemeral: false };
    }
    return merged;
  }

  // Lazily obtains CLI session manager using effective cli_options.session_ttl_ms.
  // Maintains a single instance whose TTL is fixed upon initial creation.
  private ensureCliSessionManager(ttlMs?: number): CodexCliSessionManager {
    if (!this.cliSessionManager) {
      this.cliSessionManager = new CodexCliSessionManager(ttlMs);
    }
    return this.cliSessionManager;
  }

  // Exposes CLI session manager for testing and external inspection
  getCliSessionManager(): CodexCliSessionManager | null {
    return this.cliSessionManager;
  }

  private initAppServer(): void {
    const options = this.config.app_server_options ?? {};
    const ttl = options.session_ttl_ms;

    const processConfig: CodexAppServerProcessConfig = {
      cliPath: this.config.cli_path,
      options,
      env: this.getCleanEnv(),
      workingDir: this.workingDir,
    };

    this.appServerProcess = new CodexAppServerProcess(processConfig);
    this.appServerProcess.start().catch((err) => {
      console.error('[codex] app-server initial start failed:', err.message);
    });

    if (options.enable_session_reuse !== false) {
      this.appServerSessionManager = new CodexAppServerSessionManager(ttl);
    }
  }

  private destroyAppServer(): void {
    this.appServerProcess?.stop().catch(() => { /* ignore stop error */ });
    this.appServerProcess = null;
    this.appServerSessionManager?.destroy();
    this.appServerSessionManager = null;
  }

  // Cleans up CLI session manager (called during teardown/tests)
  destroyCliSessionManager(): void {
    this.cliSessionManager?.destroy();
    this.cliSessionManager = null;
    this.warnedEphemeralForceAlias.clear();
  }

  private buildAppServerConfig(options: ExecuteOptions): AppServerExecutorConfig {
    return {
      model: options.model || this.config.default_model,
      options: this.config.app_server_options ?? {},
      process: this.appServerProcess!,
      sessionManager: this.appServerSessionManager ?? undefined,
      clientKey: options.clientKey,
      timeoutMs: this.config.timeout_ms,
    };
  }

  private appServerDebugArgs(model: string, meta?: AppServerMeta): string[] {
    const args = ['[app-server]', `model=${model}`];
    if (meta) {
      args.push(`thread=${meta.threadId ?? 'none'}`);
      args.push(`reused=${meta.threadReused}`);
      if (meta.retried) args.push('retried=true');
    }
    return args;
  }

  // Feed prompt via stdin to avoid argument length limits and shell quoting issues
  protected override getStdinData(options: ExecuteOptions): string {
    const ctx = (options as CodexExecuteOptions).__codexPrompt;
    if (ctx) return ctx.text;
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const effective = this.getEffectiveConfig(options);
    const model = options.model || effective.default_model;
    const ctx = (options as CodexExecuteOptions).__codexPrompt;

    // Requests with schema do not use resume because 'codex exec resume' does not support
    // --output-schema, which would silently drop schema enforcement. Schema compliance takes precedence over session continuity.
    const schemaPath = (options as CodexExecuteOptions).__codexSchemaPath;

    // Determine resume branch: requires session reuse enabled, clientKey, and existing thread
    let resumeThreadId: string | null = null;
    if (!schemaPath && effective.cli_options?.enable_session_reuse === true && options.clientKey && !ctx?.imageFiles?.length) {
      const sm = this.ensureCliSessionManager(effective.cli_options.session_ttl_ms);
      const existing = sm.get(options.clientKey, model);
      if (existing) {
        resumeThreadId = existing.threadId;
      }
    }
    // Requests with images start a fresh exec session for safety

    // Inject --ephemeral based on effective configuration (false persists jsonl for resume)
    const ephemeralEnabled = effective.cli_options?.ephemeral !== false;
    const userHasEphemeral = effective.extra_args.includes('--ephemeral');
    const injectEphemeral = ephemeralEnabled && !userHasEphemeral;

    // Inject reasoning effort
    const userHasReasoning = effective.extra_args.some(
      (arg) => arg === 'model_reasoning_effort' || arg.startsWith('model_reasoning_effort='),
    );
    const reasoningArgs: string[] = [];
    if (options.reasoningEffort && !userHasReasoning) {
      const effort = options.reasoningEffort === 'xhigh' || options.reasoningEffort === 'max'
        ? 'high'
        : options.reasoningEffort;
      reasoningArgs.push('-c', `model_reasoning_effort=${effort}`);
    }

    if (resumeThreadId) {
      // In 'codex exec resume <thread_id>' mode, filter out unsupported options
      // (-s/--sandbox, -C/--cd, --add-dir, -p/--profile, --oss, --local-provider, --output-schema, --color).
      const filteredExtra = filterResumeUnsupportedArgs(effective.extra_args);
      return [
        'exec',
        'resume',
        resumeThreadId,
        '--json',
        ...(injectEphemeral ? ['--ephemeral'] : []),
        ...reasoningArgs,
        ...filteredExtra,
        ...(model ? ['-m', model] : []),
        '-',
      ];
    }

    // Respect user-pinned --output-schema in extra_args
    const userHasSchema = effective.extra_args.some(
      (arg) => arg === '--output-schema' || arg.startsWith('--output-schema='),
    );
    const schemaArgs = schemaPath && !userHasSchema ? ['--output-schema', schemaPath] : [];

    const args: string[] = [
      'exec',
      // --json is required; otherwise Codex outputs TUI formatting
      '--json',
      ...(injectEphemeral ? ['--ephemeral'] : []),
      ...reasoningArgs,
      ...effective.extra_args,
      ...schemaArgs,
      ...((ctx?.imageFiles ?? []).flatMap((file) => ['--image', file])),
      // Model specification (empty string uses Codex default model)
      ...(model ? ['-m', model] : []),
      '-', // Read prompt from stdin
    ];

    return args;
  }

  // Extract text from Codex --json NDJSON event stream
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    // Legacy single JSON object format
    try {
      const data = JSON.parse(trimmed);
      if (typeof data === 'object' && !Array.isArray(data) && data.type === undefined) {
        const content = data.result ?? data.content ?? data.message ?? '';
        return {
          content,
          usage: {
            promptTokens: data.usage?.input_tokens ?? 0,
            completionTokens: data.usage?.output_tokens ?? Math.ceil(content.length / 4),
            totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? Math.ceil(content.length / 4)),
          },
          finishReason: 'stop',
        };
      }
    } catch { /* fall back to line-by-line NDJSON parsing */ }

    // Parse NDJSON line by line (extract text from item.completed)
    const result = super.parseNonStreamOutput(stdout);

    // Extract thread_id from the first line and attach to meta for SessionManager.set
    const firstLine = stdout.split('\n').find((l) => l.trim().length > 0);
    if (firstLine) {
      const threadId = extractThreadIdFromLine(firstLine);
      if (threadId) {
        return { ...result, meta: { threadId, threadReused: false } };
      }
    }
    return result;
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const config = this.buildAppServerConfig(options);
      const result = await executeAppServer(options, config);
      const model = options.model || this.config.default_model;
      // Invoke onDebug in App Server mode to prevent debug log from remaining PENDING
      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, result.appServerMeta),
        stdout: result.content,
      });
      return result;
    }
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const schema = await this.prepareSchemaFile(options);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
      ...(schema ? { __codexSchemaPath: schema.path } : {}),
    };

    // In CLI mode, determine SessionManager updates based on effective enable_session_reuse
    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;
    const wasResume = sessionReuseEnabled
      ? !!this.cliSessionManager?.get(options.clientKey!, model)
      : false;

    try {
      const result = await super.execute(ext);
      // Persist captured thread_id in SessionManager
      if (sessionReuseEnabled && result.meta?.threadId) {
        const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
        sm.set(options.clientKey!, result.meta.threadId, model);
        return { ...result, meta: { ...result.meta, threadReused: wasResume } };
      }
      return result;
    } catch (err) {
      // Invalidate session on error so subsequent requests start a fresh thread
      if (sessionReuseEnabled && this.cliSessionManager) {
        this.cliSessionManager.invalidate(options.clientKey!);
      }
      throw err;
    } finally {
      await Promise.allSettled(tempFiles.map((file) => unlink(file)));
      await schema?.cleanup();
    }
  }

  // Write schema to a temporary file per request since Codex only accepts --output-schema as a file path
  private async prepareSchemaFile(
    options: ExecuteOptions,
  ): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
    const schemaArg = schemaArgument(options.chatResponseFormat);
    if (!schemaArg) return undefined;

    const dir = await mkdtemp(join(tmpdir(), 'star-cliproxy-codex-schema-'));
    const path = join(dir, 'response-schema.json');
    try {
      await writeFile(path, `${schemaArg}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  // Codex supports schemas via --output-schema in CLI mode; app-server mode uses a distinct executor
  override supportsResponseFormat(format: ChatResponseFormat): boolean {
    if (format.type !== 'json_schema') return false;
    return !this.isAppServerMode;
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    // Emit schema requests as a single completed structured output
    if (!this.isAppServerMode && shouldBufferStream(options.chatResponseFormat)) {
      const result = await this.execute({ ...options, stream: false });
      yield { type: 'text_delta', text: result.content };
      yield { type: 'usage', usage: result.usage };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const streamLines: string[] = [];
      let streamMeta: AppServerMeta | undefined;
      const config = this.buildAppServerConfig(options);
      config.onAppServerMeta = (meta) => { streamMeta = meta; };

      for await (const event of executeStreamAppServer(options, config)) {
        if (event.type === 'text_delta') {
          streamLines.push(event.text);
        }
        yield event;
      }
      const model = options.model || this.config.default_model;
      // Invoke onDebug in App Server mode to prevent debug log from remaining PENDING
      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, streamMeta),
        streamLines,
      });
      return;
    }
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const schema = await this.prepareSchemaFile(options);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
      ...(schema ? { __codexSchemaPath: schema.path } : {}),
    };

    // In CLI mode, intercept thread_started event to update SessionManager.
    // thread_started is registered in ProviderEvent union and ignored by external SSE transformers.
    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;

    try {
      for await (const event of super.executeStream(ext)) {
        if (event.type === 'thread_started') {
          if (sessionReuseEnabled) {
            const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
            sm.set(options.clientKey!, event.threadId, model);
          }
          // Do not forward internal event to client SSE stream
          continue;
        }
        yield event;
      }
    } catch (err) {
      if (sessionReuseEnabled && this.cliSessionManager) {
        this.cliSessionManager.invalidate(options.clientKey!);
      }
      throw err;
    } finally {
      await Promise.allSettled(tempFiles.map((file) => unlink(file)));
    }
  }

  override async checkHealth(): Promise<HealthStatus> {
    if (this.isAppServerMode) {
      return this.appServerProcess?.isAlive() ? 'healthy' : 'unhealthy';
    }
    return super.checkHealth();
  }

  // Reinitialize App Server process on runtime config change
  override updateConfig(partial: Partial<ProviderConfigYaml>): void {
    const wasAppServer = this.isAppServerMode;
    super.updateConfig(partial);

    // CLI -> App Server: start process
    if (!wasAppServer && this.isAppServerMode) {
      this.initAppServer();
    }

    // App Server -> CLI: stop process
    if (wasAppServer && !this.isAppServerMode) {
      this.destroyAppServer();
    }
  }

  override async listModels(): Promise<ProviderModelInfo[]> {
    // 1. If AppServerProcess is running, request model/list
    if (this.appServerProcess?.isAlive()) {
      try {
        const res = await this.appServerProcess.request<{
          data?: Array<{ id?: string; model?: string; displayName?: string; description?: string }>;
        }>('model/list', {}, 5000);
        if (res?.data && Array.isArray(res.data)) {
          return res.data
            .map((item) => ({
              id: item.id || item.model || '',
              name: item.displayName || item.id || item.model,
              description: item.description,
            }))
            .filter((m) => m.id);
        }
      } catch (err) {
        console.warn('[codex] failed to query model/list from running app-server:', (err as Error).message);
      }
    }

    // 2. Otherwise, attempt a quick stdio query to codex app-server
    try {
      const models = await queryCodexAppServerModels(
        this.config.cli_path,
        this.getCleanEnv(),
        this.workingDir,
      );
      if (models.length > 0) {
        return models;
      }
    } catch (err) {
      console.warn('[codex] failed to query codex app-server models:', (err as Error).message);
    }

    // 3. Fallback to known models
    const fallbackList: ProviderModelInfo[] = [
      { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4-mini' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark' },
    ];

    const defaultModel = this.config.default_model;
    if (defaultModel && !fallbackList.some((m) => m.id === defaultModel)) {
      fallbackList.unshift({ id: defaultModel, name: defaultModel });
    }

    return fallbackList;
  }
}

async function queryCodexAppServerModels(
  cliPath: string,
  env: Record<string, string | undefined>,
  workingDir?: string,
): Promise<ProviderModelInfo[]> {
  return new Promise<ProviderModelInfo[]>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let childProcess: ReturnType<typeof spawn> | null = null;

    const cleanup = (models: ProviderModelInfo[]) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (childProcess) {
        try { childProcess.kill(); } catch { /* ignore */ }
      }
      resolve(models);
    };

    timer = setTimeout(() => {
      cleanup([]);
    }, 4000);

    try {
      childProcess = spawn(cliPath, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env as NodeJS.ProcessEnv,
        cwd: workingDir,
      });

      childProcess.on('error', () => {
        cleanup([]);
      });

      childProcess.on('exit', () => {
        cleanup([]);
      });

      const rl = createInterface({ input: childProcess.stdout! });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 1) {
            childProcess?.stdin?.write(
              JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }) + '\n',
            );
          } else if (msg.id === 2 && msg.result?.data && Array.isArray(msg.result.data)) {
            const models: ProviderModelInfo[] = msg.result.data
              .map((item: { id?: string; model?: string; displayName?: string; description?: string }) => ({
                id: item.id || item.model || '',
                name: item.displayName || item.id || item.model,
                description: item.description,
              }))
              .filter((m: ProviderModelInfo) => m.id);
            cleanup(models);
          }
        } catch { /* ignore parse error */ }
      });

      childProcess.stdin?.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'cliproxy', version: '1.0' } },
        }) + '\n',
      );
    } catch {
      cleanup([]);
    }
  });
}
