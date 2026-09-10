import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAiRequest, createApp } from './app.js';
import { loadConfig } from './config/loader.js';
import { closeDatabase } from './db/client.js';

describe('isAiRequest', () => {
  it('identifies AI requests correctly', () => {
    expect(isAiRequest('/v1/chat/completions')).toBe(true);
    expect(isAiRequest('/v1/models')).toBe(true);
    expect(isAiRequest('/v1/models/gpt-5.5')).toBe(true);
    expect(isAiRequest('/v1/models?all=true')).toBe(true);
    expect(isAiRequest('/v1/messages')).toBe(true);
    expect(isAiRequest('/v1/embeddings')).toBe(true);
    expect(isAiRequest('/v1/responses')).toBe(true);
    expect(isAiRequest('/admin/test-model')).toBe(true);
  });

  it('rejects non-AI requests', () => {
    expect(isAiRequest('/health')).toBe(false);
    expect(isAiRequest('/admin/dashboard')).toBe(false);
    expect(isAiRequest('/admin/dashboard?days=7')).toBe(false);
    expect(isAiRequest('/admin/active-requests')).toBe(false);
    expect(isAiRequest('/admin/server-info')).toBe(false);
    expect(isAiRequest('/admin/providers')).toBe(false);
    expect(isAiRequest('/admin/model-mappings')).toBe(false);
    expect(isAiRequest('/')).toBe(false);
    expect(isAiRequest('/models')).toBe(false);
    expect(isAiRequest('/assets/index.js')).toBe(false);
    expect(isAiRequest(undefined)).toBe(false);
    expect(isAiRequest('')).toBe(false);
  });
});

describe('Selective Request Logging in createApp', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cliproxy-log-test-'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('silences successful non-AI requests but logs AI requests and errors', async () => {
    const config = loadConfig(join(tempDir, 'missing.yaml'));
    config.database.path = join(tempDir, 'test.db');
    config.auth.enabled = false;
    config.auth.adminToken = '';
    config.auth.initialKeys = [];

    const app = await createApp(config);

    // Intercept pino output stream
    const writtenLogs: string[] = [];
    const streamSym = Object.getOwnPropertySymbols(app.log).find((s) => s.toString() === 'Symbol(pino.stream)');
    expect(streamSym).toBeDefined();
    const pinoStream = (app.log as unknown as Record<symbol, { write: (c: unknown) => boolean }>)[streamSym!];
    const origWrite = pinoStream.write.bind(pinoStream);
    pinoStream.write = function (chunk: unknown) {
      writtenLogs.push(String(chunk));
      return origWrite(chunk);
    };

    // 1. /health (heartbeat) -> should NOT log anything
    writtenLogs.length = 0;
    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(writtenLogs.filter((l) => l.includes('incoming request') || l.includes('request completed'))).toEqual([]);

    // 2. /admin/server-info (dashboard polling) -> should NOT log anything
    writtenLogs.length = 0;
    const serverInfoRes = await app.inject({ method: 'GET', url: '/admin/server-info' });
    expect(serverInfoRes.statusCode).toBe(200);
    expect(writtenLogs.filter((l) => l.includes('incoming request') || l.includes('request completed'))).toEqual([]);

    // 3. / (dashboard SPA) -> should NOT log anything
    writtenLogs.length = 0;
    const rootRes = await app.inject({ method: 'GET', url: '/' });
    expect(rootRes.statusCode).toBe(200);
    expect(writtenLogs.filter((l) => l.includes('incoming request') || l.includes('request completed'))).toEqual([]);

    // 4. /v1/models (AI request) -> MUST log incoming + completed at info level
    writtenLogs.length = 0;
    const aiRes = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(aiRes.statusCode).toBe(200);
    const aiIncoming = writtenLogs.some((l) => l.includes('incoming request') && l.includes('/v1/models'));
    const aiCompleted = writtenLogs.some((l) => l.includes('request completed'));
    expect(aiIncoming).toBe(true);
    expect(aiCompleted).toBe(true);

    // 5. Non-AI error request (404) -> MUST log error (no incoming request log)
    writtenLogs.length = 0;
    const notFoundRes = await app.inject({ method: 'GET', url: '/admin/nonexistent-endpoint' });
    expect(notFoundRes.statusCode).toBe(404);
    const errIncoming = writtenLogs.some((l) => l.includes('incoming request'));
    const errCompleted = writtenLogs.some((l) => l.includes('request completed with error'));
    expect(errIncoming).toBe(false);
    expect(errCompleted).toBe(true);

    pinoStream.write = origWrite;
    await app.close();
  }, 15000);
});
