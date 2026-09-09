import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml } from '@star-cliproxy/shared';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { OpencodeProvider } from './opencode-provider.js';

const spawnMock = vi.mocked(spawn);

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'opencode',
    default_model: 'opencode/muse-spark-1.3-contributor-free',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'opencode/muse-spark-1.3-contributor-free',
    stream: false,
    ...extra,
  };
}

function fakeChild(stdout: string, stderr = '', exitCode = 0) {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (child as unknown as { stdout: Readable }).stdout = Readable.from([Buffer.from(stdout)]);
  (child as unknown as { stderr: Readable }).stderr = Readable.from([Buffer.from(stderr)]);
  (child as unknown as { stdin: { write: () => void; end: () => void } }).stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  (child as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
  (child as unknown as { killed: boolean }).killed = false;
  setImmediate(() => (child as unknown as EventEmitter).emit('close', exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

type BuildArgs = { buildArgs(opts: ExecuteOptions): string[] };
type GetStdinData = { getStdinData(opts: ExecuteOptions): string | undefined };

describe('OpencodeProvider.buildArgs', () => {
  it('기본 인자로 run --pure --format json 및 -m <model> 생성', () => {
    const provider = new OpencodeProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args).toEqual([
      'run',
      '--pure',
      '--format',
      'json',
      '--title',
      'proxy',
      '-m',
      'opencode/muse-spark-1.3-contributor-free',
    ]);
  });

  it('모델명에 슬래시가 없으면 opencode/ 접두사 자동 추가', () => {
    const provider = new OpencodeProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ model: 'my-custom-model' }),
    );
    expect(args).toContain('-m');
    expect(args).toContain('opencode/my-custom-model');
  });

  it('모델명에 이미 provider/가 있으면 그대로 유지', () => {
    const provider = new OpencodeProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ model: 'opencodex/gpt-5.5' }),
    );
    expect(args).toContain('-m');
    expect(args).toContain('opencodex/gpt-5.5');
  });

  it('reasoningEffort가 전달되면 --variant 및 --thinking 플래그 추가', () => {
    const provider = new OpencodeProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args).toContain('--variant');
    expect(args).toContain('high');
    expect(args).toContain('--thinking');
  });

  it('extra_args가 있으면 CLI 인자에 추가', () => {
    const provider = new OpencodeProvider(
      baseConfig({ extra_args: ['--auto'] }),
    );
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args).toContain('--auto');
  });
});

describe('OpencodeProvider.getStdinData', () => {
  it('messages 배열을 단일 프롬프트 문자열로 변환하여 stdin으로 반환', () => {
    const provider = new OpencodeProvider(baseConfig());
    const stdin = (provider as unknown as GetStdinData).getStdinData(
      baseOptions({
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'What is 1+1?' },
        ],
      }),
    );
    expect(stdin).toContain('You are helpful.');
    expect(stdin).toContain('What is 1+1?');
  });
});

describe('OpencodeProvider.execute (non-stream)', () => {
  it('JSON 라인에서 응답 content와 토큰 사용량 파싱', async () => {
    const stdout = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({
        type: 'text',
        part: { type: 'text', text: 'Hello, world!' },
      }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { input: 15, output: 5, reasoning: 0, total: 20 },
        },
      }),
    ].join('\n');

    spawnMock.mockImplementation(() => fakeChild(stdout));

    const provider = new OpencodeProvider(baseConfig());
    const result = await provider.execute(baseOptions());

    expect(result.content).toBe('Hello, world!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      promptTokens: 15,
      completionTokens: 5,
      totalTokens: 20,
    });
  });

  it('error 이벤트가 포함되어 있으면 에러 throw', async () => {
    const stdout = JSON.stringify({
      type: 'error',
      error: { data: { message: 'Invalid API key' } },
    });

    spawnMock.mockImplementation(() => fakeChild(stdout));

    const provider = new OpencodeProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(
      'OpenCode CLI error: Invalid API key',
    );
  });
});

describe('OpencodeProvider.listModels', () => {
  it('opencode models 출력 중 free 모델만 필터링하여 파싱', async () => {
    const stdout = [
      'opencode/nemotron-3-ultra-free',
      'opencode/muse-spark-1.3-contributor-free',
      'opencodex/gpt-5.5',
      'google-vertex/claude-sonnet-4-6@default',
      '─ header line to ignore',
    ].join('\n');

    spawnMock.mockImplementation(() => fakeChild(stdout));

    const provider = new OpencodeProvider(baseConfig());
    const models = await provider.listModels();

    // Only free models should be returned
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual([
      'opencode/nemotron-3-ultra-free',
      'opencode/muse-spark-1.3-contributor-free',
    ]);
    expect(models.map((m) => m.name)).toEqual([
      'Nemotron 3 Ultra (Free)',
      'Muse Spark 1.3 (Free)',
    ]);
  });

  it('명령 실패 시 fallbackModels 반환', async () => {
    spawnMock.mockImplementation(() => fakeChild('', 'failed', 1));

    const provider = new OpencodeProvider(baseConfig());
    const models = await provider.listModels();

    expect(models).toEqual([
      {
        id: 'opencode/muse-spark-1.3-contributor-free',
        name: 'Muse Spark 1.3 (Free)',
      },
      {
        id: 'opencode/muse-spark-1.2-contributor-free',
        name: 'Muse Spark 1.2 (Free)',
      },
      {
        id: 'opencode/mimo-v2.5-free',
        name: 'MiMo V2.5 (Free)',
      },
      {
        id: 'opencode/ling-3.0-flash-fin-free',
        name: 'Ling 3.0 Flash Fin (Free)',
      },
    ]);
  });
});
