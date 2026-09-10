import type { ChatResponseFormat, ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess, type ProviderModelInfo } from './base-provider.js';
import { requireStructuredOutput, schemaArgument, wantsSchemaEnforcement } from './structured-output.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// macOS ARG_MAX is 1MB; bounded to 800KB.
// agy does not accept stdin for prompts; requires -p <arg>.
const MAX_PROMPT_ARG_BYTES = 800_000;

// Strip ANSI escape sequences defensively in case terminal color codes pollute response strings.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgyResultPayload {
  status?: string;
  response?: string;
  // Schema-compliant value populated only when requested with --json-schema.
  // Authoritative field since `response` may contain mixed prose and auxiliary fields.
  structured_output?: unknown;
  json_schema?: unknown;
  error?: string;
  usage?: AgyUsage;
}

function toTokenUsage(usage: AgyUsage | undefined, fallbackText = ''): TokenUsage {
  if (!usage) return estimateTokens(fallbackText);

  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
  const completionTokens = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? (promptTokens + completionTokens),
  };
}

function parseLastJsonLine(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some versions can print a diagnostic line before the final JSON object.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning: future CLI versions may emit informational lines before the result.
    }
  }
  throw new Error('agy CLI returned no valid JSON result');
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
  // agy 1.1.5+ exposes low|medium|high. Preserve the shared API's stronger
  // presets by mapping them to the strongest level this provider supports.
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

function stripEffortVariant(model: string): string {
  return model
    // Only strip Gemini effort suffixes; preserve models where the suffix is part of the model ID itself.
    .replace(/^(gemini-(?:3\.[56]-flash|3\.1-pro))-(low|medium|high)$/i, '$1')
    .replace(/\s+\((Low|Medium|High)\)$/i, '');
}

// Placeholder indicating model selection is delegated to agy backend (omits --model flag).
const MODEL_PLACEHOLDER = 'antigravity';

/**
 * Google Antigravity CLI (agy) provider.
 *
 * Specifications:
 *  - `agy models` outputs stable effort variant slugs, pinned via `--model`.
 *  - Supports `--effort low|medium|high`. Normalizes model family slug + effort combinations.
 *  - Supports `--output-format json|stream-json`. Streams agent_response deltas and maps token usage.
 *  - Session continuity defaults to fresh invocations unless opted in via extra_args.
 *  - Permission bypass flags (e.g. --dangerously-skip-permissions) are excluded by default for security.
 */
export class AgyProvider extends BaseProvider {
  readonly name = 'agy' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(
    options: ExecuteOptions,
    outputFormat: 'json' | 'stream-json' = 'json',
  ): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);

    // Include schema argument size in ARG_MAX calculation since both share the argv buffer.
    const schemaArg = schemaArgument(options.chatResponseFormat);
    const argBytes = Buffer.byteLength(prompt, 'utf8')
      + (schemaArg ? Buffer.byteLength(schemaArg, 'utf8') : 0);

    if (argBytes > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `agy: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes ` +
        `(actual ${argBytes}${schemaArg ? ', response_format schema 포함' : ''}). agy는 prompt를 -p 인수로 받아 ` +
        `-p 인수 한도(macOS ARG_MAX 1MB)에 묶임. 메시지를 줄이거나 요약 후 재시도하세요.`
      );
    }

    // agy parses print-mode flags before the print prompt. Keep all flags
    // (extra_args + --model) before -p so options such as --print-timeout and
    // --model apply to this run instead of being interpreted as prompt text or
    // ignored after the prompt.
    // Output format is an internal parser contract and takes precedence over user extra_args.
    const extraArgs = withoutValueFlag(this.config.extra_args, ['--output-format']);
    const args = [...extraArgs, '--output-format', outputFormat];

    // Forward mapped actual_model via --model, unless placeholder or already set in extra_args.
    const requestedEffort = normalizeEffort(options.reasoningEffort);
    const model = requestedEffort
      ? stripEffortVariant(options.model?.trim() ?? '')
      : options.model?.trim();
    const userSetModel = hasFlag(this.config.extra_args, ['--model']);
    if (model && model !== MODEL_PLACEHOLDER && !userSetModel) {
      args.push('--model', model);
    }

    const userSetEffort = hasFlag(this.config.extra_args, ['--effort']);
    if (requestedEffort && !userSetEffort) {
      args.push('--effort', requestedEffort);
    }

    // OpenAI response_format.json_schema -> agy --json-schema.
    // Pass only nested schema to enforce constraint directly; respect user extra_args override.
    const userSetSchema = hasFlag(this.config.extra_args, ['--json-schema']);
    if (schemaArg && !userSetSchema) {
      args.push('--json-schema', schemaArg);
    }

    args.push('-p', prompt);
    return args;
  }

  // agy CLI only supports enforcing json_schema; json_object and text modes have no CLI flags.
  override supportsResponseFormat(format: ChatResponseFormat): boolean {
    return format.type === 'json_schema';
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false }, 'json');
    const { stdout, stderr, exitCode } = await this.runOnce(args, options.signal);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`agy CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const envelope = parseLastJsonLine(stdout) as { result?: AgyResultPayload } & AgyResultPayload;
    const result = envelope.result ?? envelope;
    if (result.status !== 'SUCCESS') {
      throw new Error(`agy CLI failed: ${result.error || 'unknown error'}`);
    }

    // Return structured_output directly as message.content when schema enforcement was requested.
    const content = wantsSchemaEnforcement(options.chatResponseFormat)
      ? requireStructuredOutput(result.structured_output, 'agy', 'structured_output')
      : stripAnsi(result.response ?? '').trim();
    return {
      content,
      usage: toTokenUsage(result.usage, content),
      finishReason: 'stop',
    };
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const args = this.buildArgs({ ...options, stream: true }, 'stream-json');
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
    let finalResult: AgyResultPayload | undefined;
    let emittedText = false;
    // In stream-json mode, schema enforcement only applies to the final result event.
    // Suppress interim text deltas and emit only the final structured_output.
    const schemaEnforced = wantsSchemaEnforcement(options.chatResponseFormat);

    child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
    const closePromise = new Promise<number>((resolve) => {
      child.on('error', (err) => {
        terminalError = new Error(`Failed to spawn agy CLI: ${err.message}`);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });

    const timeout = setTimeout(() => {
      terminalError = new Error(`agy CLI timed out after ${this.config.timeout_ms}ms`);
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

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (data.event === 'step_update') {
          const step = data.step_update as Record<string, unknown> | undefined;
          if (!schemaEnforced && step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
            emittedText = true;
            yield { type: 'text_delta', text: step.text_delta };
          }
          continue;
        }

        if (data.event === 'result') {
          const result = data.result as AgyResultPayload | undefined;
          if (result?.status !== 'SUCCESS') {
            throw new Error(`agy CLI failed: ${result?.error || 'unknown error'}`);
          }
          finalResult = result;
        }
      }

      const exitCode = await closePromise;
      if (terminalError) throw terminalError;
      if (exitCode !== 0) {
        throw new Error(`agy CLI exited with code ${exitCode}: ${Buffer.concat(stderrChunks).toString('utf-8').trim()}`);
      }
      if (!finalResult) throw new Error('agy CLI stream ended without a result event');

      if (schemaEnforced) {
        // Emit only the schema-compliant JSON (deltas suppressed above).
        yield { type: 'text_delta', text: requireStructuredOutput(finalResult.structured_output, 'agy', 'structured_output') };
      } else {
        // Fallback to final response if no text deltas were emitted.
        const fallbackContent = stripAnsi(finalResult.response ?? '').trim();
        if (!emittedText && fallbackContent) {
          yield { type: 'text_delta', text: fallbackContent };
        }
      }

      // Emit done only after process exits cleanly to prevent early termination if consumer breaks early.
      yield {
        type: 'usage',
        usage: toTokenUsage(finalResult.usage, finalResult.response ?? ''),
      };
      yield { type: 'done', finishReason: 'stop' };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) gracefulKill(child);
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
        reject(new Error(`agy CLI timed out after ${this.config.timeout_ms}ms`));
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
        reject(new Error(`Failed to spawn agy CLI: ${err.message}`));
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

  override async listModels(): Promise<ProviderModelInfo[]> {
    const models: ProviderModelInfo[] = [];
    try {
      const { stdout, exitCode } = await this.runProcess(['models'], undefined, 10_000);
      if (exitCode === 0) {
        const lines = stdout.split('\n');
        for (const rawLine of lines) {
          const line = stripAnsi(rawLine).trim();
          if (!line || line.startsWith('Fetching')) continue;
          const tabParts = line.split('\t');
          if (tabParts.length >= 2) {
            const id = tabParts[0].trim();
            const name = tabParts.slice(1).join(' ').trim();
            if (id) models.push({ id, name });
          } else {
            const match = line.match(/^(\S+)\s+(.+)$/);
            if (match) {
              models.push({ id: match[1].trim(), name: match[2].trim() });
            } else if (line) {
              models.push({ id: line, name: line });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[agy] failed to list models via CLI:', (err as Error).message);
    }

    const defaultModel = this.config.default_model || 'antigravity';
    if (!models.some((m) => m.id === defaultModel)) {
      models.unshift({ id: defaultModel, name: defaultModel });
    }
    return models;
  }
}
