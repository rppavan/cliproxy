import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProviderConfigYaml, ProviderOverrides } from '@star-cliproxy/shared';
import { mergeProviderConfig, _resetOverrideWarnCache } from './provider-override.js';

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.5',
    max_concurrent: 10,
    timeout_ms: 300000,
    extra_args: ['--skip-git-repo-check'],
    cli_options: { ephemeral: true },
    ...extra,
  };
}

describe('mergeProviderConfig', () => {
  beforeEach(() => {
    _resetOverrideWarnCache();
  });

  it('returns base copy when overrides is undefined', () => {
    const base = baseConfig();
    const merged = mergeProviderConfig(base, undefined, 'codex');
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base); // Ensures a new object is returned
  });

  it('returns base copy when overrides is an empty object', () => {
    const base = baseConfig();
    const merged = mergeProviderConfig(base, {}, 'codex');
    expect(merged).toEqual(base);
  });

  it('deep merges partial cli_options while preserving other keys', () => {
    const base = baseConfig({ cli_options: { ephemeral: true } });
    const overrides: ProviderOverrides = {
      cli_options: { enable_session_reuse: true, session_ttl_ms: 3600000 },
    };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.cli_options).toEqual({
      ephemeral: true,
      enable_session_reuse: true,
      session_ttl_ms: 3600000,
    });
  });

  it('replaces base cli_options.ephemeral value', () => {
    const base = baseConfig({ cli_options: { ephemeral: true } });
    const overrides: ProviderOverrides = { cli_options: { ephemeral: false } };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.cli_options?.ephemeral).toBe(false);
  });

  it('replaces extra_args instead of appending', () => {
    const base = baseConfig({ extra_args: ['--a', '--b'] });
    const overrides: ProviderOverrides = { extra_args: ['--c'] };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.extra_args).toEqual(['--c']);
  });

  it('allows whitelisted timeout_ms and working_dir', () => {
    const base = baseConfig();
    const overrides: ProviderOverrides = { timeout_ms: 60000, working_dir: '/tmp/x' };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.timeout_ms).toBe(60000);
    expect(merged.working_dir).toBe('/tmp/x');
  });

  it('preserves immutability of base config', () => {
    const base = baseConfig({ cli_options: { ephemeral: true }, extra_args: ['--keep'] });
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    mergeProviderConfig(base, {
      extra_args: ['--new'],
      cli_options: { ephemeral: false },
    }, 'codex');
    expect(base).toEqual(baseSnapshot);
  });

  it('drops all overrides and warns once for unknown provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = baseConfig();
    const merged = mergeProviderConfig(
      base,
      { cli_options: { ephemeral: false } },
      'unknown-provider',
    );
    expect(merged).toEqual(base);
    expect(warn).toHaveBeenCalledTimes(1);
    // Second call is deduplicated; no additional warning
    mergeProviderConfig(base, { cli_options: { ephemeral: false } }, 'unknown-provider');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('merges claude mode and channel_options based on whitelist', () => {
    const base = baseConfig({
      cli_path: 'claude',
      default_model: 'claude-sonnet-4-6',
      channel_options: {
        endpoint_url: 'http://old.example',
        poll_interval_ms: 1000,
      },
    });
    const overrides: ProviderOverrides = {
      mode: 'channel-worker',
      channel_options: {
        endpoint_url: 'http://127.0.0.1:8788',
        result_timeout_ms: 120000,
        isolation: 'external',
      },
    };

    const merged = mergeProviderConfig(base, overrides, 'claude');

    expect(merged.mode).toBe('channel-worker');
    expect(merged.channel_options).toEqual({
      endpoint_url: 'http://127.0.0.1:8788',
      poll_interval_ms: 1000,
      result_timeout_ms: 120000,
      isolation: 'external',
    });
  });
});
