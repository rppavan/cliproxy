import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

/**
 * GitHub Copilot CLI provider.
 * Runs non-interactively via `copilot -p "PROMPT" -s --no-ask-user`.
 * Output is plain text without structured JSON mode.
 *
 * Auth: COPILOT_GITHUB_TOKEN env variable or pre-authenticated OAuth session.
 * Tool restrictions: --deny-tool=shell --deny-tool=write (read-only execution).
 */
export class CopilotProvider extends BaseProvider {
  readonly name = 'copilot' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;
    const prompt = convertMessagesToSinglePrompt(options.messages);

    // Copilot supports low/medium/high/xhigh; fall back 'max' to 'xhigh'.
    // Skip if --effort or --reasoning-effort is already configured in extra_args.
    const userHasEffort = this.config.extra_args.some(
      (arg) => arg === '--effort' || arg === '--reasoning-effort',
    );
    const reasoningArgs: string[] = [];
    if (options.reasoningEffort && !userHasEffort) {
      const effort = options.reasoningEffort === 'max' ? 'xhigh' : options.reasoningEffort;
      reasoningArgs.push('--effort', effort);
    }

    const args: string[] = [
      '-p', prompt,
      '-s', // Strip metadata and emit plain response to stdout
      '--no-ask-user', // Prevent interactive prompts in automated executions
      ...reasoningArgs,
      ...this.config.extra_args,
      ...(model ? ['--model', model] : []),
    ];

    return args;
  }

  // Copilot CLI outputs plain text without JSON encapsulation.
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const content = stdout.trim();
    const completionTokens = Math.ceil(content.length / 4);

    return {
      content,
      usage: {
        promptTokens: 0,
        completionTokens,
        totalTokens: completionTokens,
      },
      finishReason: 'stop',
    };
  }
}
