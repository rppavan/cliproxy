import type {
  ChatResponseFormat,
  ExecuteOptions,
  ExecuteResult,
  EmbeddingOptions,
  EmbeddingResult,
  RerankOptions,
  RerankResult,
  TtsOptions,
  TtsResult,
  ProviderEvent,
  HealthStatus,
  ProviderConfigYaml,
  HttpProviderConfig,
  DebugCaptureInfo,
} from '@star-cliproxy/shared';
import { BaseProvider, type ProviderModelInfo } from './base-provider.js';

/**
 * OpenAI-compatible HTTP API provider for local services such as MLX serve, llama.cpp server, vLLM, and Ollama.
 * Overrides CLI-related methods with fetch-based HTTP requests.
 */
export class HttpProvider extends BaseProvider {
  readonly name: string;
  override readonly endpointTypes = ['chat', 'embeddings', 'tts', 'rerank'] as const;
  private httpConfig: HttpProviderConfig;
  /** Last successful rerank wire format with upstream (defaults to TEI) */
  private rerankWireFormat: RerankWireFormat | null = null;

  constructor(providerName: string, httpConfig: HttpProviderConfig) {
    // BaseProvider requires a minimal ProviderConfigYaml even though CLI paths are unused
    const baseConfig: ProviderConfigYaml = {
      enabled: httpConfig.enabled,
      cli_path: '',
      default_model: httpConfig.default_model,
      max_concurrent: httpConfig.max_concurrent,
      timeout_ms: httpConfig.timeout_ms,
      extra_args: [],
    };
    super(baseConfig);
    this.name = providerName;
    this.httpConfig = httpConfig;
    // HttpProvider handles SSE stream parsing directly
    this.parser = { parse: () => null };
  }

  // CLI only - unused in HttpProvider
  protected buildArgs(): string[] {
    return [];
  }

  updateConfig(partial: Partial<ProviderConfigYaml>): void {
    super.updateConfig(partial);
    if ('enabled' in partial) this.httpConfig.enabled = partial.enabled!;
    if ('default_model' in partial) this.httpConfig.default_model = partial.default_model!;
    if ('max_concurrent' in partial) this.httpConfig.max_concurrent = partial.max_concurrent!;
    if ('timeout_ms' in partial) this.httpConfig.timeout_ms = partial.timeout_ms!;
  }

  updateHttpConfig(partial: Partial<HttpProviderConfig>): void {
    Object.assign(this.httpConfig, partial);
    super.updateConfig({
      enabled: this.httpConfig.enabled,
      default_model: this.httpConfig.default_model,
      max_concurrent: this.httpConfig.max_concurrent,
      timeout_ms: this.httpConfig.timeout_ms,
    });
  }

  getHttpConfig(): HttpProviderConfig {
    return { ...this.httpConfig };
  }

  // base_url includes /v1 per OpenAI SDK conventions (e.g. http://localhost:8080/v1 -> /chat/completions)
  private buildUrl(path: string): string {
    const base = this.httpConfig.base_url.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.httpConfig.api_key) {
      headers['Authorization'] = `Bearer ${this.httpConfig.api_key}`;
    }
    if (this.httpConfig.custom_headers) {
      Object.assign(headers, this.httpConfig.custom_headers);
    }
    return headers;
  }

  // Standard fields managed by cliproxy; protected from extra_body overrides.
  private static readonly RESERVED_BODY_KEYS = new Set([
    'model', 'messages', 'stream', 'max_tokens', 'temperature', 'tools', 'tool_choice',
  ]);

  // Pass through response_format directly; OpenAI-compatible backends enforce validation.
  override supportsResponseFormat(_format: ChatResponseFormat): boolean {
    return true;
  }

  private buildRequestBody(options: ExecuteOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      // Preserve function calling fields (name, tool_call_id, tool_calls) for multi-turn tool conversations.
      messages: options.messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.name !== undefined) msg.name = m.name;
        if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      stream,
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    }
    // Pass through structured output schema. Not included in RESERVED_BODY_KEYS to maintain
    // backward compatibility for configs specifying response_format via extra_body.
    if (options.chatResponseFormat) body.response_format = options.chatResponseFormat;
    // Omit max_tokens if unspecified so server defaults apply (avoiding max_total_tokens errors on vLLM, etc.)
    const maxTokens = options.maxTokens ?? this.httpConfig.default_max_tokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    // Merge non-standard backend parameters from extra_body (chat_template_kwargs, top_k, etc.)
    // while preventing overwrites of standard fields managed by cliproxy.
    if (options.extraBody && typeof options.extraBody === 'object') {
      for (const [key, value] of Object.entries(options.extraBody)) {
        if (HttpProvider.RESERVED_BODY_KEYS.has(key)) continue;
        if (value === undefined) continue;
        body[key] = value;
      }
    }
    return body;
  }


  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const url = this.buildUrl('/chat/completions');
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(options, false);

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let responseBody: OpenAIChatCompletionResponse;
      try {
        responseBody = JSON.parse(rawText) as OpenAIChatCompletionResponse;
      } catch {
        // Include raw text in debug info on parse failure
        debugInfo.rawResponseText = rawText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`);
      }

      debugInfo.rawResponseText = rawText;
      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      if (!response.ok) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        const errMsg = (responseBody as Record<string, unknown>).error
          ? JSON.stringify((responseBody as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
        throw new Error(`${this.name} HTTP error: ${errMsg}`);
      }

      options.onDebug?.(debugInfo as DebugCaptureInfo);

      const choice = responseBody.choices?.[0];
      const msg = choice?.message;
      // Preserve distinct reasoning fields if sent by backend; fall back to reasoning if content is empty.
      const rawContent = msg?.content ?? '';
      const rawReasoning = msg?.reasoning_content ?? msg?.reasoning ?? '';
      const content = rawContent || rawReasoning || '';
      const reasoning = rawContent ? rawReasoning : '';
      const usage = responseBody.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      const toolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
        ? msg.tool_calls.map((tc) => ({
            id: tc.id ?? '',
            type: 'function' as const,
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
            ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
          }))
        : undefined;

      return {
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
        finishReason: mapFinishReason(choice?.finish_reason),
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const url = this.buildUrl('/chat/completions');
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(options, true);

    const streamLines: string[] = [];
    const captureDebug = !!options.onDebug;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        debugInfo.rawResponseText = errorBody;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: errorBody,
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name} HTTP error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };

      if (!response.body) {
        throw new Error(`${this.name}: No response body for streaming request`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Incomplete trailing line remains in buffer for next chunk
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (captureDebug) streamLines.push(trimmed);

            const events = parseSSELineToEvents(trimmed);
            for (const event of events) {
              yield event;
              if (event.type === 'done') return;
            }
          }
        }

        if (buffer.trim()) {
          if (captureDebug) streamLines.push(buffer.trim());
          const events = parseSSELineToEvents(buffer.trim());
          for (const event of events) yield event;
        }
      } finally {
        // If stream ended early (via [DONE] or consumer break), releasing the lock alone
        // does not cancel the fetch body stream, leaking upstream sockets until timeout.
        // reader.cancel() aborts the underlying stream and releases the lock.
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timeoutId);
      if (captureDebug) {
        debugInfo.httpStreamLines = streamLines;
        debugInfo.rawResponseText = streamLines.join('\n');
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
    }
  }

  async executeEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const url = this.buildUrl('/embeddings');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
    };
    if (options.encodingFormat) body.encoding_format = options.encodingFormat;
    if (options.dimensions) body.dimensions = options.dimensions;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let responseBody: OpenAIEmbeddingResponse;
      try {
        responseBody = JSON.parse(rawText) as OpenAIEmbeddingResponse;
      } catch {
        debugInfo.rawResponseText = rawText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`);
      }

      debugInfo.rawResponseText = rawText;
      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      if (!response.ok) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        const errMsg = (responseBody as Record<string, unknown>).error
          ? JSON.stringify((responseBody as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
        throw new Error(`${this.name} HTTP error: ${errMsg}`);
      }

      options.onDebug?.(debugInfo as DebugCaptureInfo);

      const embeddings = (responseBody.data ?? [])
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
      const usage = responseBody.usage ?? { prompt_tokens: 0, total_tokens: 0 };

      return {
        embeddings,
        model: responseBody.model ?? options.model,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0),
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Automatically negotiates between the two upstream rerank wire formats:
  //   - TEI native: `{query, texts}` -> `[{index, score, text?}]`
  //   - OpenAI-compatible: `{model, query, documents}` -> `{results:[{index, relevance_score}]}` (Cohere, Jina, cliproxy)
  // Sends the preferred format first and retries with the alternative on 400/422 errors.
  // Caches the working format to minimize subsequent round-trips.
  async executeRerank(options: RerankOptions): Promise<RerankResult> {
    const preferred = this.rerankWireFormat ?? 'tei';
    const order: RerankWireFormat[] = preferred === 'tei' ? ['tei', 'openai'] : ['openai', 'tei'];

    let attempt = await this.attemptRerank(order[0], options);
    if (!attempt.ok && attempt.formatMismatch) {
      attempt = await this.attemptRerank(order[1], options);
      if (attempt.ok) this.rerankWireFormat = order[1];
    } else if (attempt.ok) {
      this.rerankWireFormat = order[0];
    }

    options.onDebug?.(attempt.debugInfo as DebugCaptureInfo);
    if (!attempt.ok) throw attempt.error;
    return attempt.result;
  }

  /**
   * Attempts a single rerank request, returning a result object instead of throwing
   * so the caller can decide whether to fallback.
   */
  private async attemptRerank(
    format: RerankWireFormat,
    options: RerankOptions,
  ): Promise<RerankAttempt> {
    const url = this.buildUrl('/rerank');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> =
      format === 'openai'
        ? {
            model: options.model,
            query: options.query,
            documents: options.documents,
            ...(options.returnDocuments ? { return_documents: true } : {}),
            ...(typeof options.topN === 'number' && options.topN > 0
              ? { top_n: options.topN }
              : {}),
          }
        : {
            query: options.query,
            texts: options.documents,
            ...(options.returnDocuments ? { return_text: true } : {}),
          };

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      debugInfo.rawResponseText = rawText;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        return {
          ok: false,
          formatMismatch: false,
          debugInfo,
          error: new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`),
        };
      }

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsed as Record<string, unknown>,
      };

      if (!response.ok) {
        const errObj = (parsed as Record<string, unknown>)?.error;
        const errMsg = errObj ? JSON.stringify(errObj) : `HTTP ${response.status}`;
        return {
          ok: false,
          // Status 400/422 indicates payload format mismatch suitable for wire format retry.
          // 401/403, 404, 429, and 5xx are unlikely to resolve by changing payload format.
          formatMismatch: response.status === 400 || response.status === 422,
          debugInfo,
          error: new Error(`${this.name} HTTP error: ${errMsg}`),
        };
      }

      const normalized = normalizeRerankResponse(parsed);
      if (!normalized) {
        return {
          ok: false,
          // Unrecognized 200 response shape indicates wire format mismatch; retry with alternative.
          formatMismatch: true,
          debugInfo,
          error: new Error(
            `${this.name}: Unrecognized rerank response shape: ${rawText.slice(0, 200)}`,
          ),
        };
      }

      let results = normalized.items.map((item) => ({
        index: item.index,
        relevanceScore: item.relevanceScore,
        ...(options.returnDocuments && typeof item.document === 'string'
          ? { document: item.document }
          : {}),
      }));

      // Explicitly sort descending by relevance score to guarantee consistent ordering across backends.
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);

      if (typeof options.topN === 'number' && options.topN > 0) {
        results = results.slice(0, options.topN);
      }

      // TEI does not return token usage, so approximate when missing (~chars / 4).
      const totalTokens =
        normalized.totalTokens ??
        Math.ceil(
          (options.query.length + options.documents.reduce((sum, d) => sum + d.length, 0)) / 4,
        );

      return {
        ok: true,
        debugInfo,
        result: { results, model: options.model, usage: { totalTokens } },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          formatMismatch: false,
          debugInfo,
          error: options.signal?.aborted
            ? new Error('Request cancelled')
            : new Error(
                `${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`,
              ),
        };
      }
      return {
        ok: false,
        formatMismatch: false,
        debugInfo,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async executeTts(options: TtsOptions): Promise<TtsResult> {
    const url = this.buildUrl('/audio/speech');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
      voice: options.voice,
    };
    if (options.responseFormat) body.response_format = options.responseFormat;
    if (options.speed !== undefined) body.speed = options.speed;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        debugInfo.rawResponseText = errorText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name} HTTP error: ${response.status} ${errorText.slice(0, 200)}`);
      }

      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };
      options.onDebug?.(debugInfo as DebugCaptureInfo);

      return { audio, contentType };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // === Health Check ===

  async checkHealth(): Promise<HealthStatus> {
    try {
      const url = this.buildUrl('/models');
      const headers = this.buildHeaders();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        return response.ok ? 'healthy' : 'unhealthy';
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return 'unhealthy';
    }
  }

  override async listModels(): Promise<ProviderModelInfo[]> {
    // 1. OpenAI-compatible /models endpoint
    try {
      const url = this.buildUrl('/models');
      const headers = this.buildHeaders();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (res.ok) {
          const json = (await res.json()) as { data?: Array<{ id: string }> };
          if (Array.isArray(json?.data) && json.data.length > 0) {
            return json.data.map((m) => ({ id: m.id, name: m.id }));
          }
        }
      } finally {
        clearTimeout(t);
      }
    } catch { /* ignore */ }

    // 2. Ollama /api/tags endpoint
    try {
      const url = this.buildUrl('/api/tags');
      const headers = this.buildHeaders();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (res.ok) {
          const json = (await res.json()) as { models?: Array<{ name: string }> };
          if (Array.isArray(json?.models) && json.models.length > 0) {
            return json.models.map((m) => ({ id: m.name, name: m.name }));
          }
        }
      } finally {
        clearTimeout(t);
      }
    } catch { /* ignore */ }

    if (this.config.default_model) {
      return [{ id: this.config.default_model, name: this.config.default_model }];
    }
    return [];
  }
}

function parseSSELineToEvents(line: string): ProviderEvent[] {
  // OpenAI SSE format: "data: {...}" or "data: [DONE]"
  if (!line.startsWith('data: ')) return [];

  const data = line.slice(6);

  if (data === '[DONE]') {
    return [{ type: 'done' }];
  }

  try {
    const json = JSON.parse(data) as OpenAIChatCompletionChunk;
    const delta = json.choices?.[0]?.delta;
    const finishReason = json.choices?.[0]?.finish_reason;

    if (finishReason) {
      const events: ProviderEvent[] = [];
      if (json.usage) {
        events.push({
          type: 'usage',
          usage: {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          },
        });
      }
      const reason = finishReason === 'length' ? 'length' as const
        : finishReason === 'tool_calls' ? 'tool_use' as const
        : 'stop' as const;
      events.push({ type: 'done', finishReason: reason });
      return events;
    }

    const events: ProviderEvent[] = [];

    // Emit reasoning text as thinking events, and content as text_delta events.
    const reasoningText = delta?.reasoning_content || delta?.reasoning;
    if (reasoningText) {
      events.push({ type: 'thinking', text: reasoningText });
    }
    if (delta?.content) {
      events.push({ type: 'text_delta', text: delta.content });
    }

    // Preserve backend index to distinguish parallel tool calls.
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        events.push({
          type: 'tool_use',
          toolCallId: tc.id ?? '',
          toolName: tc.function?.name ?? '',
          input: tc.function?.arguments ?? '',
          isPartial: !tc.id,
          ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
        });
      }
    }

    return events;
  } catch {
    return [];
  }
}

// Internal OpenAI response types

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIEmbeddingResponse {
  object?: string;
  data?: Array<{
    object?: string;
    embedding: number[];
    index: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

// Upstream rerank wire formats: TEI native vs OpenAI-compatible (Cohere, Jina, cliproxy).
type RerankWireFormat = 'tei' | 'openai';

// Result of attemptRerank returned to caller to determine fallback behavior.
type RerankAttempt =
  | { ok: true; result: RerankResult; debugInfo: Partial<DebugCaptureInfo> }
  | {
      ok: false;
      /** Indicates whether failure resembles a payload format mismatch eligible for retry */
      formatMismatch: boolean;
      error: Error;
      debugInfo: Partial<DebugCaptureInfo>;
    };

type NormalizedRerankItem = { index: number; relevanceScore: number; document?: string };

/**
 * Normalizes TEI and OpenAI rerank responses into a common structure.
 * Inspects response structure directly as request and response wire formats may differ.
 */
function normalizeRerankResponse(
  parsed: unknown,
): { items: NormalizedRerankItem[]; totalTokens?: number } | null {
  // TEI: top-level array
  if (Array.isArray(parsed)) {
    const items: NormalizedRerankItem[] = [];
    for (const raw of parsed) {
      const item = raw as { index?: unknown; score?: unknown; text?: unknown };
      if (typeof item?.index !== 'number' || typeof item?.score !== 'number') return null;
      items.push({
        index: item.index,
        relevanceScore: item.score,
        ...(typeof item.text === 'string' ? { document: item.text } : {}),
      });
    }
    return { items };
  }

  // OpenAI/Cohere compatible: `{results: [...], usage?: {total_tokens}}`
  const root = parsed as { results?: unknown; usage?: { total_tokens?: unknown } } | null;
  if (!Array.isArray(root?.results)) return null;

  const items: NormalizedRerankItem[] = [];
  for (const raw of root.results) {
    const item = raw as {
      index?: unknown;
      relevance_score?: unknown;
      score?: unknown;
      document?: unknown;
    };
    const score = typeof item?.relevance_score === 'number' ? item.relevance_score : item?.score;
    if (typeof item?.index !== 'number' || typeof score !== 'number') return null;
    // Cohere provides document as `{text}`, whereas others return strings.
    const doc =
      typeof item.document === 'string'
        ? item.document
        : typeof (item.document as { text?: unknown })?.text === 'string'
          ? ((item.document as { text: string }).text)
          : undefined;
    items.push({
      index: item.index,
      relevanceScore: score,
      ...(doc !== undefined ? { document: doc } : {}),
    });
  }

  const total = root?.usage?.total_tokens;
  return { items, ...(typeof total === 'number' ? { totalTokens: total } : {}) };
}

function mapFinishReason(reason?: string): 'stop' | 'length' | 'tool_calls' | 'error' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  return 'stop';
}

function maskApiKey(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  if (masked['Authorization']) {
    const token = masked['Authorization'].replace('Bearer ', '');
    if (token.length > 8) {
      masked['Authorization'] = `Bearer ${token.slice(0, 4)}...${token.slice(-4)}`;
    }
  }
  return masked;
}
