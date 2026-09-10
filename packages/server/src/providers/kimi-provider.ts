import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderConfigYaml,
  ProviderEvent,
  TokenUsage,
} from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Kimi Code does not support stdin or prompt-file input; bound to 800KB to respect macOS ARG_MAX (1MB).
const MAX_PROMPT_ARG_BYTES = 800_000;

interface KimiStreamRecord {
  role?: string;
  type?: string;
  content?: unknown;
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

function isK3Model(model: string): boolean {
  return /(?:^|\/)k3(?:-256k)?$/i.test(model.trim());
}

function normalizeKimiEffort(
  effort: ExecuteOptions['reasoningEffort'],
): 'low' | 'high' | 'max' | undefined {
  if (!effort) return undefined;
  if (effort === 'low') return 'low';
  if (effort === 'xhigh' || effort === 'max') return 'max';
  return 'high';
}

function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function estimateUsage(prompt: string, completion: string): TokenUsage {
  const promptTokens = estimateTokenCount(prompt);
  const completionTokens = estimateTokenCount(completion);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function parseRecord(line: string): KimiStreamRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as KimiStreamRecord
      : undefined;
  } catch {
    // Ignore update notices or diagnostic text mixed around JSON records.
    return undefined;
  }
}

function assistantContent(record: KimiStreamRecord | undefined): string | undefined {
  return record?.role === 'assistant' && typeof record.content === 'string'
    ? record.content
    : undefined;
}

/**
 * Moonshot AI Kimi Code CLI provider.
 *
 * - Runs headlessly via `kimi -m <alias> --output-format stream-json -p <prompt>`.
 * - stream-json emits assistant/tool/meta NDJSON; exposes only assistant content to API responses.
 *   Internal CLI tool executions are handled directly by Kimi and are not exposed as function calls.
 * - CLI output lacks token usage metadata; returns byte-based estimates instead.
 * - Forwards reasoning_effort for K3/K3-256k models via KIMI_MODEL_THINKING_EFFORT (low/high/max).
 * - Enforces KIMI_CODE_NO_AUTO_UPDATE=1 to prevent automatic updates during proxy requests.
 */
export class KimiProvider extends BaseProvider {
  readonly name = 'kimi' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `kimi: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes (actual ${promptBytes}). ` +
        'Kimi Code는 prompt를 -p 인수로만 받아 OS ARG_MAX 제한을 우회할 수 없습니다. ' +
        '메시지를 줄이거나 요약 후 재시도하세요.',
      );
    }

    if (hasFlag(this.config.extra_args, ['-y', '--yolo', '--plan'])) {
      throw new Error(
        'kimi: prompt mode cannot be combined with --yolo/-y or --plan. ' +
        '해당 플래그를 provider extra_args에서 제거하세요.',
      );
    }

    // Output format and prompt contract take precedence over user extra_args.
    const extraArgs = withoutValueFlag(
      this.config.extra_args,
      ['--output-format', '-p', '--prompt'],
    );
    const model = options.model?.trim() || this.config.default_model.trim();
    const userSetModel = hasFlag(this.config.extra_args, ['-m', '--model']);
    const modelArgs = model && !userSetModel ? ['-m', model] : [];

    return [
      ...extraArgs,
      ...modelArgs,
      '--output-format',
      'stream-json',
      '-p',
      prompt,
    ];
  }

  private getKimiEnv(options: ExecuteOptions): Record<string, string | undefined> {
    const env = this.getCleanEnv();
    env.KIMI_CODE_NO_AUTO_UPDATE = '1';

    const model = options.model?.trim() || this.config.default_model.trim();
    const effort = isK3Model(model)
      ? normalizeKimiEffort(options.reasoningEffort)
      : undefined;
    if (effort) {
      env.KIMI_MODEL_THINKING_EFFORT = effort;
    }
    return env;
  }

  private async runOnce(
    args: string[],
    options: ExecuteOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cli_path, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.getKimiEnv(options),
        cwd: this.workingDir,
        shell: process.platform === 'win32',
      });
      trackProcess(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        gracefulKill(child);
        fail(new Error('Request cancelled'));
      };
      const timeout = setTimeout(() => {
        gracefulKill(child);
        fail(new Error(`kimi CLI timed out after ${this.config.timeout_ms}ms`));
      }, this.config.timeout_ms);

      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      child.stdout?.on('data', (data: Buffer) => stdoutChunks.push(data));
      child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
      child.on('error', (err) => fail(new Error(`Failed to spawn kimi CLI: ${err.message}`)));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code ?? 1,
        });
      });
    });
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const runOptions = { ...options, stream: false };
    const prompt = convertMessagesToSinglePrompt(runOptions.messages);
    const args = this.buildArgs(runOptions);
    const { stdout, stderr, exitCode } = await this.runOnce(args, runOptions);

    options.onDebug?.({
      cliArgs: [this.config.cli_path, ...args],
      stdout,
      stderr,
    });

    if (exitCode !== 0) {
      throw new Error(`kimi CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    const content = stdout
      .split(/\r?\n/)
      .map((line) => assistantContent(parseRecord(line)))
      .filter((part): part is string => part !== undefined)
      .join('')
      .trim();

    return {
      content,
      usage: estimateUsage(prompt, content),
      finishReason: 'stop',
    };
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const runOptions = { ...options, stream: true };
    const prompt = convertMessagesToSinglePrompt(runOptions.messages);
    const args = this.buildArgs(runOptions);
    const child = spawn(this.config.cli_path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.getKimiEnv(runOptions),
      cwd: this.workingDir,
      shell: process.platform === 'win32',
    });
    trackProcess(child);

    const debugLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    const contentParts: string[] = [];
    let terminalError: Error | undefined;

    child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
    const closePromise = new Promise<number>((resolve) => {
      child.on('error', (err) => {
        terminalError = new Error(`Failed to spawn kimi CLI: ${err.message}`);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });

    const timeout = setTimeout(() => {
      terminalError = new Error(`kimi CLI timed out after ${this.config.timeout_ms}ms`);
      gracefulKill(child);
    }, this.config.timeout_ms);
    const onAbort = () => {
      terminalError = new Error('Request cancelled');
      gracefulKill(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    try {
      const rl = createInterface({ input: child.stdout! });
      for await (const line of rl) {
        if (options.onDebug) debugLines.push(line);
        const content = assistantContent(parseRecord(line));
        if (content === undefined) continue;
        contentParts.push(content);
        if (content) yield { type: 'text_delta', text: content };
      }

      const exitCode = await closePromise;
      if (terminalError) throw terminalError;
      if (exitCode !== 0) {
        throw new Error(
          `kimi CLI exited with code ${exitCode}: ` +
          (Buffer.concat(stderrChunks).toString('utf8').trim() || 'unknown error'),
        );
      }

      yield {
        type: 'usage',
        usage: estimateUsage(prompt, contentParts.join('')),
      };
      yield { type: 'done', finishReason: 'stop' };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) gracefulKill(child);
      if (options.onDebug) {
        options.onDebug({
          cliArgs: [this.config.cli_path, ...args],
          streamLines: debugLines,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      }
    }
  }
}
