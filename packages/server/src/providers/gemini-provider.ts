import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { prepareGeminiPrompt } from '../utils/image-extractor.js';
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Safety threshold for prompt text passed via `-p` in image-attachment mode.
// macOS ARG_MAX is 1MB; bounded to 800KB to allow margin.
const MAX_PROMPT_ARG_BYTES = 800_000;

// Internal context passing prepareGeminiPrompt result to buildArgs and getStdinData.
interface GeminiExecuteContext {
  text: string;
  useArg: boolean;
}

interface GeminiExecuteOptions extends ExecuteOptions {
  __geminiPrompt?: GeminiExecuteContext;
}

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected override getStdinData(options: ExecuteOptions): string | undefined {
    const ctx = (options as GeminiExecuteOptions).__geminiPrompt;
    if (ctx) {
      // Omit stdin in image mode (-p); pass prompt via stdin in text mode.
      return ctx.useArg ? undefined : ctx.text;
    }
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;

    const args: string[] = [
      '-m', model,
      '-o', options.stream ? 'stream-json' : 'json',
    ];

    args.push(...this.config.extra_args);

    const ctx = (options as GeminiExecuteOptions).__geminiPrompt;
    if (ctx?.useArg) {
      // Pass prompt containing @<path> image references via -p argument.
      args.push('-p', ctx.text);
    }
    return args;
  }

  // Collect full stdout via shell redirection.
  // Gemini CLI does not flush its trailing 8KB buffer when stdout is a pipe, causing truncation.
  // Redirecting to a file (> file) ensures the OS flushes all remaining output on process termination.
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const { ext, tempFiles } = await this.prepareImageContext(options);
    try {
      return await this.executeOnce(ext);
    } finally {
      await Promise.allSettled(tempFiles.map((f) => unlink(f)));
    }
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const { ext, tempFiles } = await this.prepareImageContext(options);
    try {
      yield* super.executeStream(ext);
    } finally {
      await Promise.allSettled(tempFiles.map((f) => unlink(f)));
    }
  }

  private async prepareImageContext(options: ExecuteOptions): Promise<{ ext: GeminiExecuteOptions; tempFiles: string[] }> {
    const { prompt, tempFiles, hasImages } = await prepareGeminiPrompt(options.messages);

    // Protect against ARG_MAX limits; fall back to text-only stdin if prompt exceeds threshold.
    if (hasImages && Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      await Promise.allSettled(tempFiles.map((f) => unlink(f)));
      console.warn(`[gemini] prompt too large for -p mode (${Buffer.byteLength(prompt, 'utf8')} bytes); falling back to text-only stdin`);
      const ext: GeminiExecuteOptions = {
        ...options,
        __geminiPrompt: { text: convertMessagesToSinglePrompt(options.messages), useArg: false },
      };
      return { ext, tempFiles: [] };
    }

    const ext: GeminiExecuteOptions = {
      ...options,
      __geminiPrompt: { text: prompt, useArg: hasImages },
    };
    return { ext, tempFiles };
  }

  private async executeOnce(options: GeminiExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const tmpFile = join(tmpdir(), `gemini-out-${randomBytes(8).toString('hex')}.json`);

    const stdinData = this.getStdinData({ ...options, stream: false });

    try {
      await new Promise<void>((resolve, reject) => {
        // Redirect stdout to file via shell to avoid pipe buffer truncation.
        // Strip null bytes to prevent early string termination across different shells.
        const isWin = process.platform === 'win32';
        const shellEscape = isWin
          ? (s: string) => '"' + s.replace(/\x00/g, '').replace(/"/g, '\\"') + '"'
          : (s: string) => "'" + s.replace(/\x00/g, '').replace(/'/g, "'\\''") + "'";
        const shellCmd = [shellEscape(this.config.cli_path), ...args.map(shellEscape)].join(' ') + ' > ' + shellEscape(tmpFile);
        const child = spawn(shellCmd, {
          stdio: ['pipe', 'ignore', 'pipe'],
          shell: true,
          env: this.getCleanEnv(),
          cwd: this.workingDir,
        });
        trackProcess(child);
        const stderrChunks: Buffer[] = [];
        child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));

        if (stdinData) {
          child.stdin?.write(stdinData);
        }
        child.stdin?.end();

        const timeout = setTimeout(() => {
          gracefulKill(child);
          reject(new Error(`gemini CLI timed out after ${this.config.timeout_ms}ms`));
        }, this.config.timeout_ms);

        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            gracefulKill(child);
            reject(new Error('Request cancelled'));
          }, { once: true });
        }

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn gemini CLI: ${err.message}`));
        });

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
            const detail = stderr ? `: ${stderr}` : '';
            reject(new Error(`gemini CLI exited with code ${code}${detail}`));
          } else {
            resolve();
          }
        });
      });

      const stdout = await readFile(tmpFile, 'utf-8');
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout });
      return this.parseNonStreamOutput(stdout);
    } catch (err) {
      // Capture partial output from file even when process reports an error.
      try {
        const stdout = await readFile(tmpFile, 'utf-8');
        if (stdout.trim()) {
          options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout });
          return this.parseNonStreamOutput(stdout);
        }
      } catch { /* file missing */ }
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stderr: (err as Error).message });
      throw err;
    } finally {
      try { await unlink(tmpFile); } catch { /* ignore if already missing */ }
    }
  }

  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    try {
      const data = JSON.parse(trimmed);

      let content = data.response ?? data.result ?? data.text ?? data.content ?? '';
      // Restore literal escaped newlines.
      if (typeof content === 'string' && content.includes('\\n')) {
        content = content.replace(/\\n/g, '\n');
      }

      const { inputTokens, outputTokens } = this.extractTokenUsage(data);

      return {
        content,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        finishReason: 'stop',
      };
    } catch {
      // Fall back to extracting embedded JSON object.
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          let content = data.response ?? data.result ?? data.text ?? data.content ?? '';
          if (typeof content === 'string' && content.includes('\\n')) {
            content = content.replace(/\\n/g, '\n');
          }
          const { inputTokens, outputTokens } = this.extractTokenUsage(data);
          return {
            content,
            usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens },
            finishReason: 'stop',
          };
        } catch { /* fallback */ }
      }

      // Extract "response" field via regex if JSON parsing fails.
      const responseMatch = trimmed.match(/"response"\s*:\s*"([\s\S]*)$/);
      if (responseMatch) {
        let content = responseMatch[1];
        content = content.replace(/"\s*,?\s*"session_id[\s\S]*$/, '');
        content = content.replace(/"\s*\}\s*$/, '');
        content = content
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        return {
          content,
          usage: { promptTokens: 0, completionTokens: Math.ceil(content.length / 4), totalTokens: Math.ceil(content.length / 4) },
          finishReason: 'stop',
        };
      }

      return super.parseNonStreamOutput(stdout);
    }
  }

  private extractTokenUsage(data: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
    const usage = data.usage as Record<string, number> | undefined;
    if (usage) {
      return {
        inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
        outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
      };
    }

    // Gemini stats schema: { stats: { models: { "<model>": { tokens: { input, candidates, total } } } } }
    const stats = data.stats as Record<string, unknown> | undefined;
    if (stats?.models && typeof stats.models === 'object') {
      const models = stats.models as Record<string, Record<string, unknown>>;
      const firstModel = Object.values(models)[0];
      if (firstModel?.tokens && typeof firstModel.tokens === 'object') {
        const tokens = firstModel.tokens as Record<string, number>;
        return {
          inputTokens: tokens.input ?? 0,
          outputTokens: tokens.candidates ?? 0,
        };
      }
    }

    return { inputTokens: 0, outputTokens: 0 };
  }

  // Streaming uses `-o stream-json` piped to BaseProvider.executeStream().
  // Gemini CLI emits delta=true events for real-time output.
}
