import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@star-cliproxy/shared';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';

const spawnMock = vi.mocked(spawn);

const jsonSchemaFormat = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'answer_shape',
    strict: true,
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
};

function config(cli: string, extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: cli,
    default_model: cli === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function options(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: extra.model ?? 'claude-sonnet-4-6',
    stream: false,
    ...extra,
  };
}

// Creates child at the time spawn is invoked. Pre-creating via mockReturnValue(fakeChild(...))
// causes the setImmediate close event to fire before spawn returns, missing the close event
// if the provider awaits async temp file I/O (e.g. codex schema file path).
function mockSpawn(stdout: string, stderr = '', exitCode = 0) {
  spawnMock.mockImplementation(() => fakeChild(stdout, stderr, exitCode));
}

function fakeChild(stdout: string, stderr = '', exitCode = 0) {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (child as unknown as { stdout: Readable }).stdout = Readable.from([Buffer.from(stdout)]);
  (child as unknown as { stderr: Readable }).stderr = Readable.from([Buffer.from(stderr)]);
  (child as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
  (child as unknown as { killed: boolean }).killed = false;
  (child as unknown as { stdin: { end: () => void; write: () => void } }).stdin = { end: vi.fn(), write: vi.fn() };
  setImmediate(() => (child as unknown as EventEmitter).emit('close', exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

type BuildArgs = { buildArgs(opts: ExecuteOptions): string[] };

describe('ClaudeProvider - structured output', () => {
  it('passes only nested schema via --json-schema (CLI mode)', () => {
    const provider = new ClaudeProvider(config('claude'));
    const args = (provider as unknown as BuildArgs).buildArgs(options({ chatResponseFormat: jsonSchemaFormat }));
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[idx + 1])).toEqual(jsonSchemaFormat.json_schema.schema);
  });

  it('does not add --json-schema for json_object/text', () => {
    const provider = new ClaudeProvider(config('claude'));
    for (const format of [{ type: 'json_object' as const }, { type: 'text' as const }]) {
      const args = (provider as unknown as BuildArgs).buildArgs(options({ chatResponseFormat: format }));
      expect(args).not.toContain('--json-schema');
    }
  });

  it('respects custom --json-schema in extra_args', () => {
    const provider = new ClaudeProvider(config('claude', { extra_args: ['--json-schema', '/etc/custom.json'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(options({ chatResponseFormat: jsonSchemaFormat }));
    expect(args.filter((arg) => arg === '--json-schema')).toHaveLength(1);
    expect(args).toContain('/etc/custom.json');
  });

  it('uses structured_output as content when present', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: '{"answer":"blue"}',
      structured_output: { answer: 'blue' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    const result = await provider.execute(options({ chatResponseFormat: jsonSchemaFormat }));
    expect(JSON.parse(result.content)).toEqual({ answer: 'blue' });
  });

  it('구조화 출력이 없으면 throw (result 텍스트 폴백 금지)', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: 'plain prose',
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    await expect(provider.execute(options({ chatResponseFormat: jsonSchemaFormat })))
      .rejects.toThrow(/structured_output/);
  });

  it('retains original result path when response_format is absent', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: 'plain answer',
      structured_output: { answer: 'ignored' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    const result = await provider.execute(options());
    expect(result.content).toBe('plain answer');
  });

  it('suppresses deltas and emits structured value once in streaming mode', async () => {
    // Observed behavior (claude 2.1.228): deltas emit raw prose ("blue") even with a schema;
    // schema-compliant values only appear in the final result after the internal StructuredOutput tool round-trip.
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: '{"answer":"blue"}',
      structured_output: { answer: 'blue' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(options({ stream: true, chatResponseFormat: jsonSchemaFormat }))) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('{"answer":"blue"}');
  });

  it('declares json_schema support only in CLI mode (not sdk/channel-worker)', () => {
    expect(new ClaudeProvider(config('claude')).supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(new ClaudeProvider(config('claude')).supportsResponseFormat({ type: 'json_object' })).toBe(false);
    expect(new ClaudeProvider(config('claude', { mode: 'sdk' })).supportsResponseFormat(jsonSchemaFormat)).toBe(false);
    expect(new ClaudeProvider(config('claude', { mode: 'channel-worker' })).supportsResponseFormat(jsonSchemaFormat)).toBe(false);
  });
});

describe('CodexProvider - structured output', () => {
  const codexOptions = (extra: Partial<ExecuteOptions> = {}) => options({ model: 'gpt-5.5', ...extra });

  it('writes schema to file and passes path via --output-schema', async () => {
    mockSpawn(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"answer":"blue"}' },
    }));
    const provider = new CodexProvider(config('codex'));
    await provider.execute(codexOptions({ chatResponseFormat: jsonSchemaFormat }));

    const args = spawnMock.mock.calls[0][1] as string[];
    const idx = args.indexOf('--output-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Codex accepts a file path rather than inline JSON
    expect(args[idx + 1]).toMatch(/\.json$/);
  });

  it('does not add --output-schema for json_object/text', async () => {
    mockSpawn(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'ok' },
    }));
    const provider = new CodexProvider(config('codex'));
    await provider.execute(codexOptions({ chatResponseFormat: { type: 'json_object' } }));
    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain('--output-schema');
  });

  it('bypasses resume branch on schema requests (codex resume lacks --output-schema)', async () => {
    mockSpawn(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"answer":"blue"}' },
    }));
    const provider = new CodexProvider(config('codex', {
      cli_options: { enable_session_reuse: true },
    }));
    // Schema requests must trigger a new exec even when a reusable session exists
    await provider.execute(codexOptions({ clientKey: 'client-1', chatResponseFormat: jsonSchemaFormat }));
    await provider.execute(codexOptions({ clientKey: 'client-1', chatResponseFormat: jsonSchemaFormat }));

    const secondArgs = spawnMock.mock.calls[1][1] as string[];
    expect(secondArgs).not.toContain('resume');
    expect(secondArgs).toContain('--output-schema');
  });

  it('declares only json_schema supported (app-server mode unsupported)', () => {
    expect(new CodexProvider(config('codex')).supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(new CodexProvider(config('codex')).supportsResponseFormat({ type: 'json_object' })).toBe(false);
    expect(new CodexProvider(config('codex', { mode: 'app-server' })).supportsResponseFormat(jsonSchemaFormat)).toBe(false);
  });
});
