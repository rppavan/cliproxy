import { describe, it, expect } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml } from '@star-cliproxy/shared';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import { CopilotProvider } from './copilot-provider.js';

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'cli',
    default_model: 'm',
    max_concurrent: 1,
    timeout_ms: 30000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'm',
    stream: false,
    ...extra,
  };
}

// Cast to access protected buildArgs in tests
function callBuildArgs(p: unknown, opts: ExecuteOptions): string[] {
  return (p as { buildArgs: (o: ExecuteOptions) => string[] }).buildArgs(opts);
}

describe('ClaudeProvider buildArgs — reasoning_effort', () => {
  it('omits --effort flag when reasoningEffort is not specified', () => {
    const p = new ClaudeProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('injects --effort high when reasoningEffort=high', () => {
    const p = new ClaudeProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('high');
  });

  it('passes through xhigh/max directly (natively supported by Claude)', () => {
    const p = new ClaudeProvider(baseConfig());
    expect(callBuildArgs(p, baseOptions({ reasoningEffort: 'xhigh' }))).toContain('xhigh');
    expect(callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }))).toContain('max');
  });

  it('does not auto-inject when --effort is already present in extra_args', () => {
    const p = new ClaudeProvider(baseConfig({ extra_args: ['--effort', 'low'] }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    // Only one --effort flag should be present (the user-specified one)
    const occurrences = args.filter((a) => a === '--effort').length;
    expect(occurrences).toBe(1);
  });
});

describe('CodexProvider buildArgs — reasoning_effort', () => {
  it('omits model_reasoning_effort when reasoningEffort is not specified', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('injects -c model_reasoning_effort=medium when reasoningEffort=medium', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'medium' }));
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort=medium');
  });

  it('falls back xhigh to high', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'xhigh' }));
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('falls back max to high', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }));
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('does not auto-inject when model_reasoning_effort is present in extra_args', () => {
    const p = new CodexProvider(baseConfig({
      extra_args: ['-c', 'model_reasoning_effort=low'],
    }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const efforts = args.filter((a) => a.startsWith('model_reasoning_effort='));
    expect(efforts).toEqual(['model_reasoning_effort=low']);
  });
});

describe('CopilotProvider buildArgs — reasoning_effort', () => {
  it('omits --effort when reasoningEffort is not specified', () => {
    const p = new CopilotProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('injects --effort high when reasoningEffort=high', () => {
    const p = new CopilotProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('high');
  });

  it('falls back max to xhigh (Copilot does not support max)', () => {
    const p = new CopilotProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('xhigh');
  });

  it('does not auto-inject when --reasoning-effort alias is in extra_args', () => {
    const p = new CopilotProvider(baseConfig({ extra_args: ['--reasoning-effort', 'low'] }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    expect(args).not.toContain('--effort');
  });
});
