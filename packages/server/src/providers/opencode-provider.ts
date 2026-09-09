import type {
  ExecuteOptions,
  ExecuteResult,
  HealthStatus,
  ProviderConfigYaml,
  TokenUsage,
} from '@star-cliproxy/shared';
import { BaseProvider, type ProviderModelInfo } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

function normalizeOpencodeVariant(
  effort: ExecuteOptions['reasoningEffort'],
): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (!effort) return undefined;
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'max') return 'max';
  return 'high';
}

function isFreeModel(id: string): boolean {
  return /free/i.test(id);
}

function formatOpencodeDisplayName(modelId: string): string {
  const base = modelId.replace(/^opencode\//, '');
  if (base === 'muse-spark-1.3-contributor-free') return 'Muse Spark 1.3 (Free)';
  if (base === 'muse-spark-1.2-contributor-free') return 'Muse Spark 1.2 (Free)';
  if (base === 'mimo-v2.5-free') return 'MiMo V2.5 (Free)';
  if (base === 'ling-3.0-flash-fin-free') return 'Ling 3.0 Flash Fin (Free)';
  if (base === 'nemotron-3-ultra-free') return 'Nemotron 3 Ultra (Free)';
  if (base === 'nemotron-3.5-lightning-free') return 'Nemotron 3.5 Lightning (Free)';
  return modelId;
}

/**
 * OpenCode CLI (`opencode`) Provider.
 *
 * Runs non-interactive tasks using:
 *   opencode run --pure --format json [-m provider/model] [--variant variant] [--thinking] ...
 *
 * Prompts are fed via stdin to avoid ARG_MAX limits.
 * Model discovery uses `opencode models`.
 */
export class OpencodeProvider extends BaseProvider {
  readonly name = 'opencode' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const args: string[] = ['run', '--pure', '--format', 'json', '--title', 'proxy'];

    let model = options.model || this.config.default_model;
    if (model) {
      model = model.trim();
      // OpenCode expects provider/model format (e.g. opencode/muse-spark-1.3-contributor-free)
      if (!model.includes('/')) {
        model = `opencode/${model}`;
      }
      args.push('-m', model);
    }

    if (options.reasoningEffort) {
      const variant = normalizeOpencodeVariant(options.reasoningEffort);
      if (variant) {
        args.push('--variant', variant);
      }
      args.push('--thinking');
    }

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    return args;
  }

  protected override getStdinData(options: ExecuteOptions): string | undefined {
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let content = '';
    let usage: TokenUsage | undefined;
    let finishReason: ExecuteResult['finishReason'] = 'stop';

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'error') {
          const msg = data.error?.data?.message || data.error?.message || 'OpenCode error';
          throw new Error(`OpenCode CLI error: ${msg}`);
        }
        if (data.type === 'text' && data.part?.text) {
          content += data.part.text;
        }
        if (data.type === 'step_finish') {
          const tokens = data.part?.tokens;
          if (tokens) {
            usage = {
              promptTokens: tokens.input ?? 0,
              completionTokens: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
              totalTokens: tokens.total ?? ((tokens.input ?? 0) + (tokens.output ?? 0)),
            };
          }
          if (data.part?.reason) {
            finishReason = data.part.reason === 'stop' ? 'stop' : (data.part.reason as ExecuteResult['finishReason']);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('OpenCode CLI error:')) {
          throw err;
        }
        // Skip non-JSON lines
      }
    }

    if (!usage) {
      const completionTokens = Math.ceil(content.length / 4);
      usage = { promptTokens: 0, completionTokens, totalTokens: completionTokens };
    }

    return { content, usage, finishReason };
  }

  override async listModels(): Promise<ProviderModelInfo[]> {
    try {
      const { stdout, exitCode } = await this.runProcess(['models'], undefined, 10_000);
      if (exitCode !== 0) {
        return this.fallbackModels();
      }
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const models: ProviderModelInfo[] = [];
      const seen = new Set<string>();

      for (const line of lines) {
        if (line.startsWith('─') || line.startsWith('┌') || line.startsWith('└') || line.includes(' ')) {
          continue;
        }
        // Only include free models for OpenCode
        if (isFreeModel(line) && !seen.has(line)) {
          seen.add(line);
          models.push({
            id: line,
            name: formatOpencodeDisplayName(line),
          });
        }
      }

      return models.length > 0 ? models : this.fallbackModels();
    } catch {
      return this.fallbackModels();
    }
  }

  private fallbackModels(): ProviderModelInfo[] {
    return [
      { id: 'opencode/muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 (Free)' },
      { id: 'opencode/muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 (Free)' },
      { id: 'opencode/mimo-v2.5-free', name: 'MiMo V2.5 (Free)' },
      { id: 'opencode/ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (Free)' },
    ];
  }

  override async checkHealth(): Promise<HealthStatus> {
    try {
      const { exitCode } = await this.runProcess(['--version'], undefined, 5_000);
      return exitCode === 0 ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }
}
