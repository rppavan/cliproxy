import type { FastifyInstance } from 'fastify';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessageContent,
  ChatMessageContentPart,
  ValidationConfig,
} from '@star-cliproxy/shared';
import { ALLOWED_ROLES, isReasoningEffort, type ReasoningEffort } from '@star-cliproxy/shared';
import { extractTextFromContent, isImagePart } from '../../utils/message-converter.js';
import { createRequestId, formatAsSSE } from '../../utils/stream-transformer.js';
import { splitReasoning, ReasoningSplitter } from '../../utils/reasoning-splitter.js';
import { extractClientKey } from '../../utils/client-key.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { ResponseCache } from '../../services/cache.js';
import type { DebugService } from '../../services/debug.js';
import type { DebugCaptureInfo } from '@star-cliproxy/shared';

interface ChatCompletionDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  validation: ValidationConfig;
  activeRequests: ActiveRequestTracker;
  cache: ResponseCache;
  debug: DebugService;
}

// Strip null bytes to prevent CLI argument injection.
function sanitizeString(str: string): string {
  return str.replace(/\x00/g, '');
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Flattens text blocks into a single string. Returns null for image blocks so callers handle them separately.
function flattenTextBlock(part: unknown): string | null {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return stringifyUnknown(part);

  const block = part as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : '';

  if (type === 'image_url' || type === 'input_image' || type === 'image') {
    return null;
  }

  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;

  if (Array.isArray(block.content)) {
    return block.content
      .map((item) => flattenTextBlock(item))
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
  }

  if (type === 'toolCall') {
    const name = typeof block.name === 'string' ? block.name : 'tool';
    const args = block.arguments ?? block.input ?? block.args;
    return `[Tool call ${name}] ${stringifyUnknown(args)}`.trim();
  }

  if (type === 'toolResult') {
    const name = typeof block.name === 'string' ? block.name : (typeof block.toolName === 'string' ? block.toolName : 'tool');
    const result = block.result ?? block.output ?? block.content ?? block.data;
    return `[Tool result ${name}] ${typeof result === 'string' ? result : stringifyUnknown(result)}`.trim();
  }

  if (type === 'thinking') {
    return typeof block.thinking === 'string' ? `[Thinking] ${block.thinking}` : '';
  }

  if (type === 'input_text' || type === 'text') {
    return typeof block.text === 'string' ? block.text : stringifyUnknown(block);
  }

  return stringifyUnknown(block);
}

// Normalizes multimodal content into sanitized text and preserved image blocks, merging adjacent text blocks.
function normalizeMessageContent(content: unknown): ChatMessageContent {
  if (typeof content === 'string') return sanitizeString(content);

  if (Array.isArray(content)) {
    const out: ChatMessageContentPart[] = [];
    let textBuffer = '';

    const flushText = () => {
      if (textBuffer.length > 0) {
        out.push({ type: 'text', text: sanitizeString(textBuffer) });
        textBuffer = '';
      }
    };

    for (const part of content) {
      if (part && typeof part === 'object' && isImagePart(part as ChatMessageContentPart)) {
        flushText();
        out.push(part as ChatMessageContentPart);
        continue;
      }
      const text = flattenTextBlock(part);
      if (text) {
        if (textBuffer.length > 0) textBuffer += '\n';
        textBuffer += text;
      }
    }
    flushText();

    if (out.length === 0) return '';
    if (out.length === 1 && out[0].type === 'text' && typeof out[0].text === 'string') {
      return out[0].text;
    }
    return out;
  }

  if (content && typeof content === 'object') {
    const text = flattenTextBlock(content);
    return sanitizeString(text ?? '');
  }
  if (content == null) return '';
  return sanitizeString(stringifyUnknown(content));
}

// Detects backend errors (e.g. vLLM) indicating tool calling is unsupported, enabling clients to fall back.
export function isToolsUnsupportedError(message: string): boolean {
  const t = (message || '').toLowerCase();
  const mentionsTools = /tool[_ -]?call|tool[_ -]?choice|tool[_ -]?parser|tool[_ -]?use|enable-auto-tool-choice|function[_ ]?call|\btools?\b/.test(t);
  // Excludes generic schema/argument errors since they indicate client input issues, not missing provider tool support.
  const failure = /not\s+support|unsupport|requires|must be set|to be set|no .*parser|not enabled|disabled/.test(t);
  return mentionsTools && failure;
}

export function isInvalidToolSchemaError(message: string): boolean {
  const t = (message || '').toLowerCase();
  return /parameters json schema/.test(t)
    && /(컴파일할 수 없|compile|schema is invalid|invalid schema)/.test(t);
}

// Strips file paths and stack frames from error messages returned to clients.
function sanitizeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .trim()
    .substring(0, 200);
}

/**
 * Guards against unhandled write errors when a client disconnects prematurely.
 */
function safeWrite(raw: NodeJS.WritableStream, data: string): boolean {
  try {
    if ((raw as unknown as Record<string, unknown>).destroyed || (raw as unknown as Record<string, unknown>).writableEnded) return false;
    return raw.write(data);
  } catch {
    return false;
  }
}

// Validates response_format upfront so malformed schemas fail with 400 before reaching provider CLI/backend.
export function validateResponseFormat(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'response_format must be an object.';
  }

  const format = value as Record<string, unknown>;
  if (format.type !== 'text' && format.type !== 'json_object' && format.type !== 'json_schema') {
    return 'response_format.type must be one of: text, json_object, json_schema.';
  }
  if (format.type !== 'json_schema') return null;

  const wrapper = format.json_schema;
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
    return 'response_format.json_schema is required and must be an object when type is "json_schema".';
  }
  const schema = (wrapper as Record<string, unknown>).schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'response_format.json_schema.schema must be a JSON Schema object.';
  }
  return null;
}

function makeValidationError(message: string, param?: string) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      param: param ?? null,
      code: 'invalid_request',
    },
  };
}

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  deps: ChatCompletionDeps,
): void {
  const v = deps.validation;

  app.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      if (!body.model || !body.messages?.length) {
        return reply.status(400).send(makeValidationError('model and messages are required.'));
      }

      if (!Array.isArray(body.messages)) {
        return reply.status(400).send(makeValidationError('messages must be an array.', 'messages'));
      }

      if (body.messages.length > v.maxMessageCount) {
        return reply.status(400).send(makeValidationError(`Too many messages: ${body.messages.length}. Maximum is ${v.maxMessageCount}.`, 'messages'));
      }

      let totalPromptLength = 0;
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];

        if (!ALLOWED_ROLES.includes(msg.role as typeof ALLOWED_ROLES[number])) {
          return reply.status(400).send(makeValidationError(`Invalid role "${msg.role}" at messages[${i}]. Allowed: ${ALLOWED_ROLES.join(', ')}`, 'messages'));
        }

        if (msg.role === 'developer') {
          msg.role = 'system';
        }

        // Preserve multimodal arrays for pass-through to vision-capable providers.
        const normalizedContent = normalizeMessageContent(msg.content);
        msg.content = normalizedContent;

        // Enforce maxMessageLength only on extracted text; base64 image payloads are governed by bodyLimitBytes.
        const textLength = extractTextFromContent(normalizedContent).length;
        if (textLength > v.maxMessageLength) {
          return reply.status(400).send(makeValidationError(`messages[${i}].content too long: ${textLength} chars. Maximum is ${v.maxMessageLength}.`, 'messages'));
        }

        totalPromptLength += textLength;
      }

      if (totalPromptLength > v.maxPromptLength) {
        return reply.status(400).send(makeValidationError(`Total prompt length too long: ${totalPromptLength} chars. Maximum is ${v.maxPromptLength}.`, 'messages'));
      }

      body.model = sanitizeString(body.model);

      if (body.response_format != null) {
        const formatError = validateResponseFormat(body.response_format);
        if (formatError) {
          return reply.status(400).send({
            error: {
              message: formatError,
              type: 'invalid_request_error',
              param: 'response_format',
              code: 'invalid_response_format',
            },
          });
        }
      }

      const unsupportedParams: string[] = [];
      if (body.temperature != null) unsupportedParams.push('temperature');
      if (body.max_tokens != null) unsupportedParams.push('max_tokens');
      if ((body as unknown as Record<string, unknown>).top_p != null) unsupportedParams.push('top_p');
      if ((body as unknown as Record<string, unknown>).frequency_penalty != null) unsupportedParams.push('frequency_penalty');
      if ((body as unknown as Record<string, unknown>).presence_penalty != null) unsupportedParams.push('presence_penalty');

      const routes = await deps.router.resolve(body.model);
      if (routes.length === 0) {
        return reply.status(400).send({
          error: {
            message: `Model "${body.model}" not found. Check model mappings.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }

      // Overrides model mapping when reasoning_effort is explicitly specified in the request body.
      let bodyReasoningEffort: ReasoningEffort | undefined;
      if (body.reasoning_effort != null) {
        const normalized = typeof body.reasoning_effort === 'string'
          ? body.reasoning_effort.trim().toLowerCase()
          : '';
        if (!isReasoningEffort(normalized)) {
          return reply.status(400).send({
            error: {
              message: 'reasoning_effort must be one of: low, medium, high, xhigh, max.',
              type: 'invalid_request_error',
              param: 'reasoning_effort',
              code: 'invalid_reasoning_effort',
            },
          });
        }
        bodyReasoningEffort = normalized;
      }

      // Do not split reasoning markers out of structured JSON outputs, where markers inside string values would corrupt JSON.
      const structuredRequested = body.response_format?.type === 'json_schema';

      const bodyIncludeReasoning: boolean | undefined = typeof body.include_reasoning === 'boolean'
        ? body.include_reasoning
        : undefined;

      const apiKeyId = (request as unknown as { apiKeyId?: string }).apiKeyId;
      const keyLimits = (request as unknown as { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits;
      const clientKey = extractClientKey(request, apiKeyId);

      // Bypass cache for tool calls (requires unique call IDs) and response_format (schema not included in cache key).
      const requestHash = !body.stream
        && !(body.tools && body.tools.length > 0)
        && !body.response_format
        ? deps.cache.generateHash(body.model, body.messages)
        : undefined;

      if (!body.stream && requestHash) {
        const cached = await deps.cache.get(requestHash);
        if (cached) {
          const cachedBody = JSON.parse(cached.responseBody) as ChatCompletionResponse;

          reply.header('X-Cache', 'HIT');
          reply.header('X-Request-ID', createRequestId());

          logRequest({
            requestId: createRequestId(),
            apiKeyId,
            modelAlias: body.model,
            provider: cached.provider,
            actualModel: routes[0].actualModel,
            reasoningEffort: bodyReasoningEffort ?? routes[0].reasoningEffort,
            status: 'success',
            statusCode: 200,
            promptTokens: cachedBody.usage?.prompt_tokens,
            completionTokens: cachedBody.usage?.completion_tokens,
            totalTokens: cachedBody.usage?.total_tokens,
            latencyMs: Date.now() - startTime,
            isStream: false,
            requestHash,
          });

          return reply.status(200).send(cachedBody);
        }
      }

      // Consume global/key rate limit quota once per request before attempting provider fallbacks.
      const gkResult = deps.rateLimiter.checkGlobalAndKey(apiKeyId ?? 'anonymous', keyLimits);
      if (!gkResult.allowed) {
        reply.header('Retry-After', String(gkResult.retryAfterSeconds ?? 30));
        return reply.status(429).send({
          error: {
            message: `Rate limit exceeded. Retry after ${gkResult.retryAfterSeconds} seconds.`,
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        });
      }

      let lastError: Error | null = null;
      let rateLimitRetryAfter: number | null = null;

      for (const route of routes) {
        const healthy = await deps.healthChecker.isHealthy(route.provider);
        if (!healthy) {
          lastError = new Error(`Provider ${route.provider} is unhealthy`);
          continue;
        }

        const provRate = deps.rateLimiter.checkProvider(route.provider);
        if (!provRate.allowed) {
          rateLimitRetryAfter = provRate.retryAfterSeconds ?? 30;
          lastError = new Error(`Provider ${route.provider} rate limit exceeded`);
          continue;
        }

        const provider = deps.registry.get(route.provider);
        if (!provider) {
          lastError = new Error(`Provider ${route.provider} not available`);
          continue;
        }

        // If routed to a provider unable to enforce structured outputs, proceed with the request
        // but notify client via header (computed per fallback route).
        const routeUnsupportedParams = body.response_format
          && !provider.supportsResponseFormat(body.response_format)
          ? [...unsupportedParams, 'response_format']
          : unsupportedParams;

        deps.activeRequests.start({
          requestId,
          modelAlias: body.model,
          provider: route.provider,
          actualModel: route.actualModel,
          reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
          isStream: body.stream ?? false,
          startedAt: startTime,
        });

        const debugEnabled = deps.debug.isEnabled(body.model);
        let debugCapture: DebugCaptureInfo | undefined;
        let debugLogId: string | undefined;
        const onDebug = debugEnabled
          ? (info: DebugCaptureInfo) => { debugCapture = info; }
          : undefined;

        if (debugEnabled) {
          debugLogId = await deps.debug.logStart({
            requestId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            isStream: body.stream ?? false,
            requestMessages: body.messages,
          });
        }

        try {
          if (body.stream) {
            const abortController = new AbortController();
            // Use named handler to prevent listener leak across fallbacks; remove in finally.
            const onClientClose = () => abortController.abort();
            request.raw.once('close', onClientClose);

            try {
            await deps.queue.enqueue(route.provider, async () => {
            if (abortController.signal.aborted) return;

            // Manually apply CORS headers since writing directly to reply.raw bypasses Fastify CORS middleware.
            const origin = request.headers.origin;
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Request-ID': requestId,
              ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
              ...(routes.indexOf(route) > 0 ? { 'X-Fallback-Provider': route.provider } : {}),
              ...(routeUnsupportedParams.length > 0 ? { 'X-Unsupported-Params': routeUnsupportedParams.join(',') } : {}),
            });

            const streamIncludeReasoning = bodyIncludeReasoning ?? (route.includeReasoning ?? false);
            const sseOptions = { includeReasoning: streamIncludeReasoning };
            // Only activate splitter when reasoning policy is explicit, preventing non-reasoning model outputs
            // from accidentally misclassifying content into thinking blocks.
            const reasoningExplicit = bodyIncludeReasoning !== undefined
              || (route.includeReasoning !== null && route.includeReasoning !== undefined);
            const streamSplitter = reasoningExplicit && !structuredRequested ? new ReasoningSplitter() : null;

            const roleChunk = formatAsSSE(
              { type: 'delta', content: '' },
              requestId,
              body.model,
              sseOptions,
            );
            if (roleChunk) safeWrite(reply.raw, roleChunk);

            let totalContent = '';
            let ttfbMs: number | undefined;
            let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

            const streamIterator = provider.executeStream({
              messages: body.messages,
              model: route.actualModel,
              stream: true,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              signal: abortController.signal,
              onDebug,
              clientKey,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              providerOverrides: route.providerOverrides,
              extraBody: route.extraBody,
              tools: body.tools,
              toolChoice: body.tool_choice,
              chatResponseFormat: body.response_format,
            });

            const emitTextDelta = (text: string): boolean => {
              if (!streamSplitter || !text) {
                const sse = formatAsSSE({ type: 'text_delta', text }, requestId, body.model, sseOptions);
                if (sse && !safeWrite(reply.raw, sse)) return false;
                totalContent += text;
                return true;
              }
              const split = streamSplitter.push(text);
              if (split.reasoning) {
                const sse = formatAsSSE({ type: 'thinking', text: split.reasoning }, requestId, body.model, sseOptions);
                if (sse && !safeWrite(reply.raw, sse)) return false;
              }
              if (split.content) {
                const sse = formatAsSSE({ type: 'text_delta', text: split.content }, requestId, body.model, sseOptions);
                if (sse && !safeWrite(reply.raw, sse)) return false;
                totalContent += split.content;
              }
              return true;
            };

            try {
              for await (const event of streamIterator) {
                if (!ttfbMs) {
                  ttfbMs = Date.now() - startTime;
                }

                if (event.type === 'text_delta') {
                  if (!emitTextDelta(event.text)) break;
                } else {
                  const sseData = formatAsSSE(event, requestId, body.model, sseOptions);
                  if (sseData) {
                    if (!safeWrite(reply.raw, sseData)) break;
                  }
                  if (event.type === 'usage') {
                    streamUsage = event.usage;
                  }
                }

                if (totalContent.length > v.maxResponseLength) {
                  const doneSSE = formatAsSSE({ type: 'done' as const }, requestId, body.model, sseOptions);
                  if (doneSSE) safeWrite(reply.raw, doneSSE);
                  break;
                }
                if (event.type === 'done') break;
              }

              // Flush any remaining buffered tokens in the splitter at stream end.
              if (streamSplitter) {
                const tail = streamSplitter.flush();
                if (tail.reasoning) {
                  const sse = formatAsSSE({ type: 'thinking', text: tail.reasoning }, requestId, body.model, sseOptions);
                  if (sse) safeWrite(reply.raw, sse);
                }
                if (tail.content) {
                  const sse = formatAsSSE({ type: 'text_delta', text: tail.content }, requestId, body.model, sseOptions);
                  if (sse) safeWrite(reply.raw, sse);
                  totalContent += tail.content;
                }
              }
            } catch (streamErr) {
              // After headers are committed, emit SSE error and terminate; fallback is no longer possible.
              const errMsg = streamErr instanceof Error ? streamErr.message : 'Stream interrupted';
              safeWrite(reply.raw, `data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
              safeWrite(reply.raw, 'data: [DONE]\n\n');
              reply.raw.end();

              logRequest({
                requestId,
                apiKeyId,
                modelAlias: body.model,
                provider: route.provider,
                actualModel: route.actualModel,
                reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                status: 'error',
                statusCode: 200,
                latencyMs: Date.now() - startTime,
                isStream: true,
                errorMessage: errMsg,
              });

              deps.activeRequests.finish(requestId);
              deps.healthChecker.onRequestFailure(route.provider);
              return;
            }

            reply.raw.end();

            const streamLatency = Date.now() - startTime;
            logRequest({
              requestId,
              apiKeyId,
              modelAlias: body.model,
              provider: route.provider,
              actualModel: route.actualModel,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              status: 'success',
              statusCode: 200,
              promptTokens: streamUsage?.promptTokens ?? 0,
              completionTokens: streamUsage?.completionTokens ?? Math.ceil(totalContent.length / 4),
              totalTokens: streamUsage?.totalTokens ?? Math.ceil(totalContent.length / 4),
              latencyMs: streamLatency,
              ttfbMs,
              isStream: true,
            });

            if (debugLogId && debugCapture) {
              deps.debug.logComplete(debugLogId, {
                requestId,
                cliArgs: debugCapture.cliArgs,
                streamLines: debugCapture.streamLines,
                httpRequest: debugCapture.httpRequest,
                httpResponse: debugCapture.httpResponse,
                httpStreamLines: debugCapture.httpStreamLines,
                rawResponseText: debugCapture.rawResponseText,
                parsedContent: totalContent,
                tokenUsage: streamUsage,
                status: 'success',
                latencyMs: streamLatency,
              });
            }

            deps.activeRequests.finish(requestId);
            });

            return;
            } finally {
              request.raw.removeListener('close', onClientClose);
            }
          }

          const result = await deps.queue.enqueue(
            route.provider,
            () => provider.execute({
              messages: body.messages,
              model: route.actualModel,
              stream: false,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              onDebug,
              clientKey,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              providerOverrides: route.providerOverrides,
              extraBody: route.extraBody,
              tools: body.tools,
              toolChoice: body.tool_choice,
              chatResponseFormat: body.response_format,
            }),
          );

          // Split reasoning markers out of content when the provider does not supply a separate reasoning field.
          let content = result.content;
          let reasoning = result.reasoning ?? '';
          if (!reasoning && !structuredRequested) {
            const split = splitReasoning(content);
            if (split.reasoning) {
              reasoning = split.reasoning;
              content = split.content;
            }
          }
          if (content.length > v.maxResponseLength) {
            content = content.substring(0, v.maxResponseLength);
          }

          const effectiveInclude = bodyIncludeReasoning ?? (route.includeReasoning ?? false);
          const hasToolCalls = !!result.toolCalls && result.toolCalls.length > 0;
          const assistantMessage: ChatCompletionResponse['choices'][0]['message'] = {
            role: 'assistant',
            content,
            ...(hasToolCalls ? { tool_calls: result.toolCalls } : {}),
            ...(effectiveInclude && reasoning ? { reasoning_content: reasoning } : {}),
          };

          // Normalize finish_reason to 'tool_calls' when calls exist (some backends return 'stop').
          const finishReason: ChatCompletionResponse['choices'][0]['finish_reason'] = hasToolCalls
            ? 'tool_calls'
            : result.finishReason === 'error' ? 'stop' : result.finishReason;

          const response: ChatCompletionResponse = {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{
              index: 0,
              message: assistantMessage,
              finish_reason: finishReason,
            }],
            usage: {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
            },
          };

          if (routes.indexOf(route) > 0) {
            reply.header('X-Fallback-Provider', route.provider);
          }
          reply.header('X-Request-ID', requestId);
          reply.header('X-Cache', 'MISS');
          if (routeUnsupportedParams.length > 0) {
            reply.header('X-Unsupported-Params', routeUnsupportedParams.join(','));
          }
          // Expose thread_id for client reference when reusing Codex sessions via X-Cliproxy-Session-Id.
          if (result.meta?.threadId) {
            reply.header('X-Cliproxy-Thread-Id', result.meta.threadId);
          }

          if (requestHash) {
            await deps.cache.set(
              requestHash,
              body.model,
              route.provider,
              JSON.stringify(response),
              result.usage.totalTokens,
            );
          }

          const nonStreamLatency = Date.now() - startTime;
          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            status: 'success',
            statusCode: 200,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs: nonStreamLatency,
            isStream: false,
            requestHash,
          });

          if (debugLogId && debugCapture) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture.cliArgs,
              rawStdout: debugCapture.stdout,
              rawStderr: debugCapture.stderr,
              httpRequest: debugCapture.httpRequest,
              httpResponse: debugCapture.httpResponse,
              httpStreamLines: debugCapture.httpStreamLines,
              rawResponseText: debugCapture.rawResponseText,
              parsedContent: content,
              tokenUsage: result.usage,
              status: 'success',
              latencyMs: nonStreamLatency,
            });
          }

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(response);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isTimeout = lastError.message.includes('timed out');

          const errLatency = Date.now() - startTime;
          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            status: isTimeout ? 'timeout' : 'error',
            statusCode: isTimeout ? 504 : 502,
            latencyMs: errLatency,
            isStream: body.stream ?? false,
            errorMessage: lastError.message,
          });

          if (debugLogId) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture?.cliArgs,
              rawStdout: debugCapture?.stdout,
              rawStderr: debugCapture?.stderr,
              streamLines: debugCapture?.streamLines,
              httpRequest: debugCapture?.httpRequest,
              httpResponse: debugCapture?.httpResponse,
              httpStreamLines: debugCapture?.httpStreamLines,
              rawResponseText: debugCapture?.rawResponseText,
              status: isTimeout ? 'timeout' : 'error',
              latencyMs: errLatency,
              errorMessage: lastError.message,
            });
          }

          deps.activeRequests.finish(requestId);
          deps.healthChecker.onRequestFailure(route.provider);
          continue;
        }
      }

      // Return 429 instead of 502 when all candidate providers were exhausted by provider rate limits.
      if (rateLimitRetryAfter !== null) {
        reply.header('Retry-After', String(rateLimitRetryAfter));
        return reply.status(429).send({
          error: {
            message: `Rate limit exceeded. Retry after ${rateLimitRetryAfter} seconds.`,
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        });
      }

      // Schema compilation failures in Tool Bridge are client input errors, not provider failures.
      if (body.tools && body.tools.length > 0 && lastError && isInvalidToolSchemaError(lastError.message)) {
        return reply.status(400).send({
          error: {
            message: sanitizeProviderError(lastError.message),
            type: 'invalid_request_error',
            param: 'tools',
            code: 'invalid_tool_schema',
          },
        });
      }

      // Return 400 with tools_not_supported so clients can cleanly fall back to regular chat without tools.
      if (body.tools && body.tools.length > 0 && lastError && isToolsUnsupportedError(lastError.message)) {
        return reply.status(400).send({
          error: {
            message: `Model "${body.model}" does not support tool calling. The backend rejected the 'tools' request. `
              + `If self-hosting vLLM, start it with --enable-auto-tool-choice and a matching --tool-call-parser.`,
            type: 'invalid_request_error',
            param: 'tools',
            code: 'tools_not_supported',
          },
        });
      }

      const isTimeout = lastError?.message.includes('timed out') ?? false;
      const statusCode = isTimeout ? 504 : 502;

      return reply.status(statusCode).send({
        error: {
          message: `All providers failed for model "${body.model}". Last error: ${sanitizeProviderError(lastError?.message ?? 'unknown')}`,
          type: isTimeout ? 'timeout_error' : 'provider_error',
          param: null,
          code: isTimeout ? 'timeout' : 'provider_error',
        },
      });
    },
  );
}
