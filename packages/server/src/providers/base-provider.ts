import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import type {
  ChatResponseFormat,
  ExecuteOptions,
  ExecuteResult,
  EmbeddingOptions,
  EmbeddingResult,
  TtsOptions,
  TtsResult,
  ProviderEvent,
  TokenUsage,
  HealthStatus,
  ProviderConfigYaml,
  EndpointType,
  StreamParser,
} from '@star-cliproxy/shared';
import { streamChunkToEvents } from '@star-cliproxy/shared';
import { getParserForProvider } from '../utils/stream-transformer.js';

// Active child processes tracked for server shutdown cleanup
const activeProcesses = new Set<ChildProcess>();

export function trackProcess(child: ChildProcess): void {
  activeProcesses.add(child);
  child.on('close', () => activeProcesses.delete(child));
  child.on('error', () => activeProcesses.delete(child));
}

/** Gracefully kills all tracked child processes upon server shutdown. */
export function killAllChildProcesses(): void {
  for (const child of activeProcesses) {
    gracefulKill(child);
  }
  activeProcesses.clear();
}

export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

export interface ProviderModelInfo {
  id: string;
  name?: string;
  description?: string;
}

export abstract class BaseProvider {
  abstract readonly name: string;

  readonly endpointTypes: readonly EndpointType[] = ['chat'];

  protected config: ProviderConfigYaml;
  protected parser: StreamParser;

  constructor(config: ProviderConfigYaml) {
    this.config = config;
    // Initialized via initParser() in subclasses once name is set
    this.parser = null!;
  }

  updateConfig(partial: Partial<ProviderConfigYaml>): void {
    Object.assign(this.config, partial);
  }

  getConfig(): ProviderConfigYaml {
    return { ...this.config };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    if (this.config.default_model) {
      return [{ id: this.config.default_model, name: this.config.default_model }];
    }
    return [];
  }

  /**
   * Indicates whether this provider can enforce or forward the given response_format
   * to the backend. Defaults to false; unsupported requests proceed while routes
   * notify clients via X-Unsupported-Params header.
   */
  supportsResponseFormat(_format: ChatResponseFormat): boolean {
    return false;
  }

  protected initParser() {
    this.parser = getParserForProvider(this.name);
  }

  protected abstract buildArgs(options: ExecuteOptions): string[];

  // Large prompts are passed via stdin to bypass OS ARG_MAX limits (1MB macOS, 2MB Linux).
  // Returns undefined to close stdin immediately when unused.
  protected getStdinData(_options: ExecuteOptions): string | undefined {
    return undefined;
  }

  private fullCommand(args: string[]): string[] {
    return [this.config.cli_path, ...args];
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const stdinData = this.getStdinData({ ...options, stream: false });
    const { stdout, stderr, exitCode } = await this.runProcess(args, options.signal, undefined, stdinData);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: this.fullCommand(args), stdout, stderr });
      throw new Error(`${this.name} CLI exited with code ${exitCode}: ${stderr}`);
    }

    options.onDebug?.({ cliArgs: this.fullCommand(args), stdout, stderr });
    return this.parseNonStreamOutput(stdout, options);
  }

  async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const args = this.buildArgs({ ...options, stream: true });
    const stdinData = this.getStdinData({ ...options, stream: true });
    const child = this.spawnProcess(args);
    if (stdinData) {
      child.stdin?.write(stdinData);
    }
    child.stdin?.end();

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        gracefulKill(child);
      }, { once: true });
    }

    const timeout = setTimeout(() => {
      gracefulKill(child);
    }, this.config.timeout_ms);

    const debugLines: string[] = [];
    const captureDebug = !!options.onDebug;

    try {
      const rl = createInterface({ input: child.stdout! });

      for await (const line of rl) {
        if (captureDebug) debugLines.push(line);

        // Prefer parseEvents; adapt legacy parse if unavailable
        if (this.parser.parseEvents) {
          const events = this.parser.parseEvents(line);
          for (const event of events) {
            yield event;
            if (event.type === 'done') return;
          }
        } else {
          const chunk = this.parser.parse(line);
          if (chunk) {
            const events = streamChunkToEvents(chunk);
            for (const event of events) {
              yield event;
            }
            if (chunk.type === 'done') return;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      gracefulKill(child);
      if (captureDebug) {
        options.onDebug!({ cliArgs: this.fullCommand(args), streamLines: debugLines });
      }
    }
  }

  async executeEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResult> {
    throw new Error(`${this.name} does not support embeddings`);
  }

  async executeTts(_options: TtsOptions): Promise<TtsResult> {
    throw new Error(`${this.name} does not support text-to-speech`);
  }

  async checkHealth(): Promise<HealthStatus> {
    try {
      const { exitCode } = await this.runProcess(['--version'], undefined, 10_000);
      return exitCode === 0 ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }

  // Strip parent process environment variables to prevent nested session detection
  protected getCleanEnv(): Record<string, string | undefined> {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENABLE_TASKS;
    delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    return env;
  }

  protected get workingDir(): string {
    return this.config.working_dir ?? tmpdir();
  }

  protected spawnProcess(args: string[]): ChildProcess {
    // Windows npm global CLI wrappers (.cmd/.bat) require shell: true
    const isWin = process.platform === 'win32';
    const child = spawn(this.config.cli_path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.getCleanEnv(),
      cwd: this.workingDir,
      shell: isWin,
    });
    trackProcess(child);
    return child;
  }

  protected async runProcess(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(args);
      if (stdinData) {
        child.stdin?.write(stdinData);
      }
      child.stdin?.end();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        gracefulKill(child);
        reject(new Error(`${this.name} CLI timed out after ${timeoutMs ?? this.config.timeout_ms}ms`));
      }, timeoutMs ?? this.config.timeout_ms);

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
        reject(new Error(`Failed to spawn ${this.name} CLI: ${err.message}`));
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

  // Extracts text from non-streaming CLI output; options provides context for structured output
  protected parseNonStreamOutput(stdout: string, _options?: ExecuteOptions): ExecuteResult {
    const lines = stdout.trim().split('\n');
    const contentParts: string[] = [];
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (this.parser.parseEvents) {
      for (const line of lines) {
        const events = this.parser.parseEvents(line);
        for (const event of events) {
          if (event.type === 'text_delta') contentParts.push(event.text);
          if (event.type === 'usage') usage = event.usage;
        }
      }
    } else {
      for (const line of lines) {
        const chunk = this.parser.parse(line);
        if (chunk?.type === 'delta' && chunk.content) {
          contentParts.push(chunk.content);
        }
        if (chunk?.type === 'done' && chunk.usage) {
          usage = chunk.usage;
        }
      }
    }

    const content = contentParts.join('');

    if (usage.totalTokens === 0) {
      usage = estimateTokens(content);
    }

    return {
      content,
      usage,
      finishReason: 'stop',
    };
  }
}

// Escalates SIGTERM to SIGKILL after a grace period to prevent zombie processes
export function gracefulKill(child: ChildProcess, timeoutMs = 3000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, timeoutMs);
  killTimer.unref?.();
  child.once('close', () => clearTimeout(killTimer));
}

// Rough token heuristic: ~4 characters per token
function estimateTokens(text: string): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const completionTokens = Math.ceil(text.length / 4);
  return {
    promptTokens: 0,
    completionTokens,
    totalTokens: completionTokens,
  };
}
