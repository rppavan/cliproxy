import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from '@star-cliproxy/shared';

function findDashboardDist(projectRoot?: string): string | null {
  const candidates: string[] = [];
  if (projectRoot) {
    candidates.push(
      resolve(projectRoot, 'packages', 'dashboard', 'dist'),
      resolve(projectRoot, 'dashboard', 'dist'),
      resolve(projectRoot, 'dist'),
    );
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  candidates.push(
    resolve(currentDir, '..', '..', 'dashboard', 'dist'),
    resolve(currentDir, '..', '..', '..', 'packages', 'dashboard', 'dist'),
  );

  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}
import { initDatabase } from './db/client.js';
import { createProviderRegistry } from './providers/provider-registry.js';
import { ModelRouter } from './services/router.js';
import { ModelCatalog } from './services/model-catalog.js';
import { QueueManager } from './services/queue.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { HealthChecker } from './services/health-checker.js';
import { authMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { registerChatCompletionsRoute } from './routes/v1/chat-completions.js';
import { registerMessagesRoute } from './routes/v1/messages.js';
import { registerModelsRoute } from './routes/v1/models.js';
import { registerImageGenerationsRoute } from './routes/v1/images-generations.js';
import { registerEmbeddingsRoute } from './routes/v1/embeddings.js';
import { registerRerankRoute } from './routes/v1/rerank.js';
import { registerAudioSpeechRoute } from './routes/v1/audio-speech.js';
import { registerModelMappingsRoutes } from './routes/admin/model-mappings.js';
import { registerApiKeysRoutes } from './routes/admin/api-keys.js';
import { registerStatsRoutes } from './routes/admin/stats.js';
import { registerProvidersRoutes, sanitizeRuntimeProviderConfig } from './routes/admin/providers.js';
import { registerChannelBridgeRoutes, maybeAutoStartBridge } from './routes/admin/channel-bridge.js';
import { registerTestModelRoute } from './routes/admin/test-model.js';
import { registerRateLimitsRoutes, loadRateLimitsFromDb } from './routes/admin/rate-limits.js';
import { loadProviderConfigFromDb } from './routes/admin/providers.js';
import { registerDashboardRoute } from './routes/admin/dashboard.js';
import { ActiveRequestTracker } from './services/active-requests.js';
import { ResponseCache } from './services/cache.js';
import { DebugService } from './services/debug.js';
import { registerDebugRoutes } from './routes/admin/debug.js';
import { registerSettingsRoutes, loadValidationFromDb } from './routes/admin/settings.js';
import { registerExportImportRoutes } from './routes/admin/export-import.js';
import { registerGenericProviderRoutes } from './routes/admin/generic-providers.js';
import { registerHttpProviderRoutes } from './routes/admin/http-providers.js';
import { loadGenericProviders } from './providers/generic-provider-loader.js';
import { loadHttpProviders } from './providers/http-provider-loader.js';
import { ToolBridgeProvider } from './providers/tool-bridge-provider.js';
import { seedDatabase } from './db/seed.js';
import { loadPlugins } from './plugins/plugin-loader.js';
import type { ValidationConfig } from '@star-cliproxy/shared';

export async function createApp(config: AppConfig, projectRoot?: string) {
  // Admin API auth check (only required when auth is enabled)
  if (config.auth.enabled && !config.auth.adminToken) {
    throw new Error('ADMIN_TOKEN must be set when auth is enabled. Set it in .env or config.yaml.');
  }

  // DB 초기화
  await initDatabase(config.database.path);

  // 시드 데이터 (초기 API 키, 모델 매핑)
  await seedDatabase(config);

  // Provider 레지스트리 (빌트인)
  const registry = createProviderRegistry(config.providers);

  // 기존 CLI provider와 분리된 Tool Bridge 인스턴스 등록
  for (const [name, bridgeConfig] of Object.entries(config.toolBridgeProviders)) {
    if (bridgeConfig.enabled) {
      registry.register(new ToolBridgeProvider(name, bridgeConfig));
    }
  }

  // 플러그인 로드 (config.yaml의 plugins 섹션)
  if (config.plugins.length > 0) {
    const pluginResult = await loadPlugins(config.plugins, registry, {
      info: (msg) => console.log(`[plugin] ${msg}`),
      warn: (msg) => console.warn(`[plugin] ${msg}`),
    }, projectRoot);

    // 플러그인 프로바이더의 큐와 rate limit 설정
    for (const name of pluginResult.loaded) {
      const provider = registry.get(name);
      if (provider) {
        const pluginEntry = config.plugins.find((p) => {
          const providerObj = registry.get(name);
          return providerObj?.name === name;
        });
        const maxConcurrent = pluginEntry?.config?.max_concurrent ?? 2;
        config.providers[name] = {
          enabled: true,
          cli_path: pluginEntry?.config?.cli_path ?? '',
          default_model: pluginEntry?.config?.default_model ?? '',
          max_concurrent: maxConcurrent,
          timeout_ms: pluginEntry?.config?.timeout_ms ?? 120000,
          extra_args: pluginEntry?.config?.extra_args ?? [],
        };
        if (!config.rateLimits.perProvider[name]) {
          config.rateLimits.perProvider[name] = { rpm: 20 };
        }
      }
    }
  }

  // DB에서 저장된 Rate Limits 로드 (없으면 config.yaml 기본값 사용)
  const savedRateLimits = await loadRateLimitsFromDb(config.rateLimits);

  // DB에서 저장된 Validation 설정 로드 (없으면 config.yaml 기본값 사용)
  const savedValidation = await loadValidationFromDb();
  let currentValidation: ValidationConfig = savedValidation ?? { ...config.validation };

  // 서비스
  const modelCatalog = new ModelCatalog(registry);
  const router = new ModelRouter(registry, modelCatalog);
  const queueManager = new QueueManager();
  const rateLimiter = new RateLimiter(savedRateLimits);
  const healthChecker = new HealthChecker(registry);
  const activeRequests = new ActiveRequestTracker();
  const cache = new ResponseCache(config.cache);
  const debug = new DebugService();

  // Provider별 큐 설정
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.enabled) {
      queueManager.addQueue(name, providerConfig.max_concurrent);
    }
  }

  // DB에서 제네릭 프로바이더 로드 및 등록
  await loadGenericProviders(registry, queueManager, {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  });

  // DB에서 HTTP 프로바이더 로드 및 등록
  await loadHttpProviders(registry, queueManager, {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  });

  // DB에서 프로바이더 설정 오버라이드 로드 (이전 세션에서 대시보드로 변경한 값)
  for (const provider of registry.getAll()) {
    const override = await loadProviderConfigFromDb(provider.name);
    if (override) {
      const sanitizedOverride = sanitizeRuntimeProviderConfig(provider.name, override);
      if (Object.keys(sanitizedOverride).length === 0) continue;

      registry.updateProviderConfig(provider.name, sanitizedOverride);
      if (sanitizedOverride.max_concurrent !== undefined) {
        queueManager.updateConcurrency(provider.name, sanitizedOverride.max_concurrent);
      }
    }
  }

  // Fastify 앱
  const app = Fastify({
    bodyLimit: config.validation.bodyLimitBytes,
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    },
  });

  // CORS: ["*"]이면 모든 origin 허용 (로컬 프록시용), 아니면 지정된 origin만 허용
  const corsOrigins = config.server.cors.origins;
  const allowAll = corsOrigins.length === 1 && corsOrigins[0] === '*';
  await app.register(cors, {
    origin: allowAll ? true : corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    // allowedHeaders 생략 → 클라이언트가 요청한 헤더를 그대로 반영 (reflect)
    // Obsidian Copilot 등이 x-stainless-*, dangerously-allow-browser 등 커스텀 헤더 전송
  });

  // Dashboard UI 정적 파일 서빙 (포트 8300 통합)
  const dashboardDist = findDashboardDist(projectRoot);
  if (dashboardDist) {
    await app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: '/',
    });
  }

  // Health check (인증 불필요)
  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: registry.getAll().map((p) => p.name),
    });
  });

  // 서버 설정 정보 (대시보드 API 가이드에서 실제 URL 표시용)
  app.get('/admin/server-info', async (_request, reply) => {
    return reply.send({
      serverPort: config.server.port,
      serverHost: config.server.host,
      dashboardPort: config.dashboard.port,
      dashboardHost: config.dashboard.host,
      authEnabled: config.auth.enabled,
    });
  });

  // OpenAI-compatible 라우트 (/v1/* 엔드포인트 대상 인증)
  if (config.auth.enabled) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/v1')) return;
      await authMiddleware(request, reply);
    });
  }

  // Admin 라우트 (별도 인증 - auth.enabled일 때만 적용)
  if (config.auth.enabled) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/admin')) return;
      if (request.url === '/admin/server-info') return;
      await adminAuthMiddleware(request, reply, config.auth.adminToken);
    });
  }

  // /v1/responses: OpenAI Responses API 호환
  // Obsidian Copilot 등 일부 클라이언트가 이 엔드포인트를 사용
  // 내부적으로 /v1/chat/completions를 호출한 뒤 Responses API 형식으로 변환
  app.post('/v1/responses', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const wantStream = body.stream === true;

    // input → messages 변환
    let messages = body.messages;
    if (!messages) {
      const input = body.input;
      if (typeof input === 'string') {
        messages = [{ role: 'user', content: input }];
      } else if (Array.isArray(input)) {
        messages = input;
      } else {
        messages = [{ role: 'user', content: '' }];
      }
    }

    // 항상 non-streaming으로 내부 호출 (결과를 변환해야 하므로)
    const redirectBody = {
      model: body.model,
      messages,
      stream: false,
      max_tokens: body.max_output_tokens ?? body.max_tokens,
      temperature: body.temperature,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: request.headers.authorization,
      },
      payload: JSON.stringify(redirectBody),
    });

    if (response.statusCode !== 200) {
      return reply.status(response.statusCode).headers(response.headers).send(response.payload);
    }

    let chatResult: Record<string, unknown>;
    try {
      chatResult = JSON.parse(response.payload);
    } catch {
      return reply.status(502).send({ error: 'Failed to parse upstream response' });
    }

    const choice = (chatResult.choices as Array<Record<string, unknown>>)?.[0];
    const msg = choice?.message as Record<string, string> | undefined;
    const content = msg?.content ?? '';
    const respId = (chatResult.id as string) ?? `resp_${Date.now()}`;
    const model = (chatResult.model as string) ?? (body.model as string);
    const usage = chatResult.usage as Record<string, number> | undefined;

    const responsesResult = {
      id: respId,
      object: 'response',
      created_at: (chatResult.created as number) ?? Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: content }],
      }],
      usage: usage ? {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      } : undefined,
    };

    if (!wantStream) {
      return reply.status(200).send(responsesResult);
    }

    // 스트리밍 모드: Responses API SSE 형식으로 이벤트 전송
    const origin = request.headers.origin;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    });

    const sse = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // response.created
    sse('response.created', {
      type: 'response.created',
      response: { ...responsesResult, status: 'in_progress', output: [] },
    });

    // response.output_item.added
    sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', content: [] },
    });

    // response.content_part.added
    sse('response.content_part.added', {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });

    // response.output_text.delta — 청크 단위로 전송
    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: content.substring(i, i + chunkSize),
      });
    }

    // response.output_text.done
    sse('response.output_text.done', {
      type: 'response.output_text.done',
      output_index: 0,
      content_index: 0,
      text: content,
    });

    // response.output_item.done
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: responsesResult.output[0],
    });

    // response.completed
    sse('response.completed', {
      type: 'response.completed',
      response: responsesResult,
    });

    reply.raw.end();
  });

  // v1 라우트 등록
  registerChatCompletionsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: currentValidation,
    activeRequests,
    cache,
    debug,
  });
  registerMessagesRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: currentValidation,
    activeRequests,
    cache,
    debug,
  });
  registerModelsRoute(app, { modelCatalog });
  registerImageGenerationsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });
  registerEmbeddingsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });
  registerRerankRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });
  registerAudioSpeechRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });

  // Admin 라우트 등록
  registerModelMappingsRoutes(app, { registry, modelCatalog });
  registerApiKeysRoutes(app);
  registerStatsRoutes(app);
  registerProvidersRoutes(app, {
    registry,
    healthChecker,
    queueManager,
    defaultConfigs: config.providers,
  });
  registerChannelBridgeRoutes(app, { defaultConfigs: config.providers });
  // managed + auto_start면 부팅 시 내장 bridge 자동 시작 (실패해도 서버 부팅은 계속)
  void maybeAutoStartBridge({ defaultConfigs: config.providers });
  registerTestModelRoute(app, registry);
  registerRateLimitsRoutes(app, rateLimiter, config.rateLimits);
  registerDebugRoutes(app, debug);
  registerSettingsRoutes(app, {
    getValidation: () => currentValidation,
    setValidation: (v) => {
      // 기존 객체의 프로퍼티를 덮어쓰기 (chat-completions가 참조 유지)
      Object.assign(currentValidation, v);
    },
  });
  registerExportImportRoutes(app, {
    rateLimiter,
    defaultRateLimits: config.rateLimits,
    getValidation: () => currentValidation,
    setValidation: (v) => { Object.assign(currentValidation, v); },
    config,
    registry,
    queueManager,
    healthChecker,
  });
  registerGenericProviderRoutes(app, { registry, healthChecker, queueManager });
  registerHttpProviderRoutes(app, { registry, healthChecker, queueManager });
  registerDashboardRoute(app, { registry, queueManager, activeRequests });

  // 활성 요청 API
  app.get('/admin/active-requests', async (_request, reply) => {
    return reply.send({
      count: activeRequests.count(),
      requests: activeRequests.getAll(),
    });
  });

  // 건강 체크 시작
  healthChecker.start(60_000);

  // 만료 캐시 정리 주기: 5분 간격
  const cacheCleanupTimer = setInterval(async () => {
    const deleted = await cache.cleanup();
    if (deleted > 0) {
      app.log.info(`Cache cleanup: ${deleted} expired entries removed`);
    }
  }, 5 * 60 * 1000);

  // 종료 처리
  app.addHook('onClose', async () => {
    healthChecker.stop();
    await rateLimiter.destroy();
    clearInterval(cacheCleanupTimer);
  });

  // SPA fallback 및 404 핸들러
  app.setNotFoundHandler((request, reply) => {
    // /v1, /admin, /health가 아닌 GET/HEAD 요청은 대시보드 SPA로 라우팅
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.url.startsWith('/v1') &&
      !request.url.startsWith('/admin') &&
      !request.url.startsWith('/health')
    ) {
      if (dashboardDist) {
        return (reply as unknown as { sendFile: (file: string) => void }).sendFile('index.html');
      }
      return reply.status(200).type('text/html').send(`<!DOCTYPE html>
<html>
  <head><title>star-cliproxy</title></head>
  <body style="font-family: sans-serif; text-align: center; padding: 50px;">
    <h2>star-cliproxy Server is Running</h2>
    <p>Dashboard build not found. Run <code>npm run build</code> to build the dashboard UI.</p>
    <p><a href="/health">/health</a> | <a href="/admin/server-info">/admin/server-info</a></p>
  </body>
</html>`);
    }

    return reply.status(404).send({
      error: {
        message: `Route ${request.method}:${request.url} not found`,
        type: 'invalid_request_error',
        param: null,
        code: 'not_found',
      },
    });
  });

  return app;
}
