import type { ChatResponseFormat, ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { requireStructuredOutput, schemaArgument, shouldBufferStream, wantsSchemaEnforcement } from './structured-output.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// macOS ARG_MAX is 1MB; bounded to 800KB.
// Short prompts pass via `-p <arg>`; large prompts use `--prompt-file`.
const MAX_PROMPT_ARG_BYTES = 800_000;

// Strip ANSI escape sequences in case terminal color or cursor codes pollute JSON output.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

interface GrokUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

interface GrokJsonResult {
  type?: string;
  data?: string;
  text?: string;
  // Schema-compliant value populated only when requested with --json-schema; casing varies by version.
  structuredOutput?: unknown;
  structured_output?: unknown;
  error?: string;
  message?: string;
  stopReason?: string;
  usage?: GrokUsage;
}

// Check both camelCase and snake_case to support different grok CLI versions.
function grokStructuredOutput(result: GrokJsonResult): unknown {
  return result.structuredOutput ?? result.structured_output;
}

interface PreparedInvocation {
  args: string[];
  cleanup?: () => Promise<void>;
}

function toTokenUsage(usage: GrokUsage | undefined, fallbackText = ''): TokenUsage {
  if (!usage) return estimateTokens(fallbackText);

  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? (promptTokens + completionTokens),
  };
}

function parseLastJsonLine(stdout: string): GrokJsonResult {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as GrokJsonResult;
  } catch {
    // Some versions can print a diagnostic line before the final JSON object.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]) as GrokJsonResult;
    } catch {
      // Update notices and diagnostics can precede the JSON result.
    }
  }
  throw new Error('grok CLI returned no valid JSON result');
}

function toFinishReason(stopReason: string | undefined): 'stop' | 'length' {
  return stopReason && /max.?tokens?/i.test(stopReason) ? 'length' : 'stop';
}

function hasFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function withoutValueFlag(args: string[], flags: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flags.some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (flags.includes(arg)) {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function normalizeEffort(effort: ExecuteOptions['reasoningEffort']): 'low' | 'medium' | 'high' | undefined {
  if (!effort) return undefined;
  // grok-4.5 currently advertises low|medium|high. Map the shared API's
  // stronger presets to high instead of forwarding values the CLI rejects.
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

/**
 * xAI Grok Build CLI (`grok`, "Grok Build TUI") provider.
 *
 * Behavior:
 *  - Headless one-shot execution: `grok -m <model> -p <prompt> --output-format json`.
 *  - Supports -m/--model to forward actual_model.
 *  - grok-4.5 --effort supports low|medium|high; maps xhigh|max to high.
 *  - Preserves token usage and text/thought deltas via --output-format json|streaming-json.
 *  - Prompts over 800KB use --prompt-file to circumvent OS ARG_MAX limits.
 *  - Session continuity defaults to fresh invocations unless opted in via extra_args.
 *  - Permission bypass flags (e.g. --always-approve) are excluded by default for security.
 */
export class GrokProvider extends BaseProvider {
  readonly name = 'grok' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  private buildCommonArgs(options: ExecuteOptions, outputFormat: 'json' | 'streaming-json'): string[] {
    const model = options.model || this.config.default_model;
    const extraArgs = withoutValueFlag(this.config.extra_args, ['--output-format']);

    // Skip if --effort or --reasoning-effort is already specified in extra_args.
    const userHasEffort = hasFlag(this.config.extra_args, ['--effort', '--reasoning-effort']);
    const effort = normalizeEffort(options.reasoningEffort);
    const effortArgs = effort && !userHasEffort
      ? ['--effort', effort]
      : [];

    const updateArgs = hasFlag(this.config.extra_args, ['--no-auto-update'])
      ? []
      : ['--no-auto-update'];
    const modelArgs = model ? ['-m', model] : [];

    // OpenAI response_format.json_schema maps to grok --json-schema.
    // Respect explicit --json-schema if already configured in extra_args.
    const schemaArg = schemaArgument(options.chatResponseFormat);
    const userHasSchema = hasFlag(this.config.extra_args, ['--json-schema']);
    const schemaArgs = schemaArg && !userHasSchema ? ['--json-schema', schemaArg] : [];

    return [
      ...extraArgs,
      ...updateArgs,
      ...effortArgs,
      ...modelArgs,
      ...schemaArgs,
      '--output-format',
      outputFormat,
    ];
  }

  protected buildArgs(
    options: ExecuteOptions,
    outputFormat: 'json' | 'streaming-json' = 'json',
  ): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `grok: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes in direct argument mode; ` +
        'execute()/executeStream() will use --prompt-file for this payload.'
      );
    }
    return [...this.buildCommonArgs(options, outputFormat), '-p', prompt];
  }

  private async prepareInvocation(
    options: ExecuteOptions,
    outputFormat: 'json' | 'streaming-json',
  ): Promise<PreparedInvocation> {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_ARG_BYTES) {
      return { args: [...this.buildCommonArgs(options, outputFormat), '-p', prompt] };
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'star-cliproxy-grok-'));
    const promptPath = join(tempDir, 'prompt.txt');
    try {
      await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }
    return {
      args: [...this.buildCommonArgs(options, outputFormat), '--prompt-file', promptPath],
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
    };
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const invocation = await this.prepareInvocation({ ...options, stream: false }, 'json');
    const { args } = invocation;
    let stdout = '';
    let stderr = '';
    let exitCode = 1;
    try {
      ({ stdout, stderr, exitCode } = await this.runOnce(args, options.signal));
    } finally {
      await invocation.cleanup?.();
    }

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`grok CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const result = parseLastJsonLine(stdout);
    if (result.type === 'error' || result.error) {
      throw new Error(`grok CLI failed: ${result.message || result.error || 'unknown error'}`);
    }

    // Use structured output as authoritative content when schema enforcement was requested.
    const content = wantsSchemaEnforcement(options.chatResponseFormat)
      ? requireStructuredOutput(grokStructuredOutput(result), 'grok', 'structuredOutput')
      : stripAnsi(result.text ?? result.data ?? '').trim();
    return {
      content,
      usage: toTokenUsage(result.usage, content),
      finishReason: toFinishReason(result.stopReason),
    };
  }

  // Grok CLI only supports enforcing json_schema; json_object and text modes have no CLI flags.
  override supportsResponseFormat(format: ChatResponseFormat): boolean {
    return format.type === 'json_schema';
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    // Emit schema requests once as a complete structured payload (see structured-output.ts).
    // Buffer stream chunks to ensure consistent structured output delivery across CLI versions.
    if (shouldBufferStream(options.chatResponseFormat)) {
      const result = await this.execute({ ...options, stream: false });
      yield { type: 'text_delta', text: result.content };
      yield { type: 'usage', usage: result.usage };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const invocation = await this.prepareInvocation({ ...options, stream: true }, 'streaming-json');
    const { args } = invocation;
    const child = spawn(this.config.cli_path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.getCleanEnv(),
      cwd: this.workingDir,
      shell: process.platform === 'win32',
    });
    trackProcess(child);

    const debugLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    let terminalError: Error | undefined;
    let endEvent: GrokJsonResult | undefined;

    child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
    const closePromise = new Promise<number>((resolve) => {
      child.on('error', (err) => {
        terminalError = new Error(`Failed to spawn grok CLI: ${err.message}`);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });

    const timeout = setTimeout(() => {
      terminalError = new Error(`grok CLI timed out after ${this.config.timeout_ms}ms`);
      gracefulKill(child);
    }, this.config.timeout_ms);

    const onAbort = () => {
      terminalError = new Error('Request cancelled');
      gracefulKill(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const rl = createInterface({ input: child.stdout! });
      for await (const line of rl) {
        if (options.onDebug) debugLines.push(line);

        let data: GrokJsonResult;
        try {
          data = JSON.parse(line) as GrokJsonResult;
        } catch {
          continue;
        }

        if (data.type === 'text' && data.text) {
          // Some builds use `text`, while the public contract uses `data`.
          yield { type: 'text_delta', text: data.text };
        } else if (data.type === 'text' && data.data) {
          yield { type: 'text_delta', text: data.data };
        } else if (data.type === 'thought') {
          const thought = data.data ?? data.text;
          if (thought) yield { type: 'thinking', text: thought };
        } else if (data.type === 'error') {
          throw new Error(`grok CLI failed: ${data.message || data.error || 'unknown error'}`);
        } else if (data.type === 'end') {
          endEvent = data;
        }
      }

      const exitCode = await closePromise;
      if (terminalError) throw terminalError;
      if (exitCode !== 0) {
        throw new Error(`grok CLI exited with code ${exitCode}: ${Buffer.concat(stderrChunks).toString('utf-8').trim()}`);
      }
      if (!endEvent) throw new Error('grok CLI stream ended without an end event');

      yield { type: 'usage', usage: toTokenUsage(endEvent.usage) };
      yield {
        type: 'done',
        finishReason: toFinishReason(endEvent.stopReason),
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) gracefulKill(child);
      await invocation.cleanup?.();
      if (options.onDebug) {
        options.onDebug({
          cliArgs: [this.config.cli_path, ...args],
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          streamLines: debugLines,
        });
      }
    }
  }

  // Inlined process execution because BaseProvider.runProcess is private.
  private runOnce(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const child = spawn(this.config.cli_path, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.getCleanEnv(),
        cwd: this.workingDir,
        shell: isWin,
      });
      trackProcess(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        gracefulKill(child);
        reject(new Error(`grok CLI timed out after ${this.config.timeout_ms}ms`));
      }, this.config.timeout_ms);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          gracefulKill(child);
          reject(new Error('Request cancelled'));
        }, { once: true });
      }

      child.stdout?.on('data', (data: Buffer) => stdoutChunks.push(data));
      child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn grok CLI: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: code ?? 1,
        });
      });
    });
  }
}
