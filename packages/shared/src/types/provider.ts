import type { ChatMessage, ChatCompletionTool, ChatResponseFormat, ToolChoice, ChatMessageToolCall } from './api.js';

export const BUILTIN_PROVIDERS = ['claude', 'codex', 'copilot', 'gemini', 'agy', 'grok', 'kimi', 'opencode'] as const;
export type BuiltinProviderName = typeof BUILTIN_PROVIDERS[number];

export type ProviderName = string;

// 'rerank' is supported only by HTTP providers (CLI/plugin providers do not support reranking).
export type EndpointType = 'chat' | 'images' | 'tts' | 'embeddings' | 'rerank';

// Matches ProviderConfigYaml to avoid circular import with config.ts
export interface PluginProviderConfig {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  [key: string]: unknown;
}

export interface CliproxyPlugin {
  name: string;
  endpointTypes: EndpointType[];
  createProvider(config: PluginProviderConfig): CliproxyPluginProvider;
  createParser?(): StreamParser;
}

export interface CliproxyPluginProvider {
  readonly name: string;
  readonly endpointTypes?: EndpointType[];
  execute(options: ExecuteOptions): Promise<ExecuteResult>;
  /** @deprecated Prefer ProviderEvent-based AsyncIterable */
  executeStream?(options: ExecuteOptions): AsyncIterable<StreamChunk | ProviderEvent>;
  checkHealth(): Promise<HealthStatus>;
}

export interface StreamParser {
  /** @deprecated Use parseEvents() instead */
  parse(line: string): StreamChunk | null;
  parseEvents?(line: string): ProviderEvent[];
}

export interface ProviderConfig {
  name: ProviderName;
  enabled: boolean;
  cliPath: string;
  defaultModel: string;
  maxConcurrent: number;
  timeoutMs: number;
  extraArgs: string[];
}

export interface DebugCaptureInfo {
  cliArgs: string[];
  stdout?: string;
  stderr?: string;
  streamLines?: string[];

  httpRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  httpResponse?: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
  };
  httpStreamLines?: string[];

  rawResponseText?: string;
}

// Reasoning effort levels normalized per provider.
// Codex/Grok/Agy fall back unsupported levels to supported ranges.
// Kimi K3 normalizes to low/high/max; ignored for other Kimi models.
// Ignored by Gemini CLI.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
] as const;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string'
    && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export interface ExecuteOptions {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
  clientKey?: string; // Client identifier for session reuse (API key ID or X-Cliproxy-Session-Id header)
  reasoningEffort?: ReasoningEffort;
  providerOverrides?: import('./config.js').ProviderOverrides;
  // Passthrough fields for non-standard backend options (HTTP providers only); ignored by CLI providers.
  extraBody?: Record<string, unknown>;
  // Function calling: passed through by HTTP providers, converted to structured output by Tool Bridge, ignored by CLI providers.
  tools?: ChatCompletionTool[];
  toolChoice?: ToolChoice;
  // OpenAI structured output (response_format), separated from image generation responseFormat.
  chatResponseFormat?: ChatResponseFormat;
  // Image generation passthrough (OpenAI Images API)
  responseFormat?: 'url' | 'b64_json';
  n?: number;
  size?: string;
}

export interface ExecuteMeta {
  threadId?: string;       // Extracted from codex CLI thread.started event
  threadReused?: boolean;  // Whether the call reused an existing session thread
}

export interface EmbeddingOptions {
  model: string;
  input: string | string[];
  encodingFormat?: 'float' | 'base64';
  dimensions?: number;
  signal?: AbortSignal;
  providerOverrides?: import('./config.js').ProviderOverrides;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}

// Cohere Rerank API-compatible options (HTTP providers only).
export interface RerankOptions {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  returnDocuments?: boolean;
  signal?: AbortSignal;
  providerOverrides?: import('./config.js').ProviderOverrides;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface RerankResultItem {
  index: number;
  relevanceScore: number;
  document?: string;
}

export interface RerankResult {
  results: RerankResultItem[];
  model: string;
  usage: {
    totalTokens: number;
  };
}

export interface TtsOptions {
  model: string;
  input: string;
  voice: string;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ExecuteResult {
  content: string;
  /** Reasoning/thinking content preserved separately from content. */
  reasoning?: string;
  /** Function calling tool requests from the model (HTTP providers non-streaming). */
  toolCalls?: ChatMessageToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  meta?: ExecuteMeta;
}

export interface ProviderTextDeltaEvent {
  type: 'text_delta';
  text: string;
}

export interface ProviderToolUseEvent {
  type: 'tool_use';
  toolCallId: string;
  toolName: string;
  input: string;        // Complete arguments JSON string or streaming delta
  isPartial?: boolean;  // True for streaming JSON delta
  index?: number;       // Distinguishes parallel tool calls (matches OpenAI delta.tool_calls[].index)
}

export interface ProviderThinkingEvent {
  type: 'thinking';
  text: string;
}

export interface ProviderUsageEvent {
  type: 'usage';
  usage: TokenUsage;
}

export interface ProviderErrorEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface ProviderDoneEvent {
  type: 'done';
  finishReason?: 'stop' | 'length' | 'tool_use' | 'error';
}

// Captured internally by codex CLI provider to update SessionManager; excluded from external SSE emission.
export interface ProviderThreadStartedEvent {
  type: 'thread_started';
  threadId: string;
}

export type ProviderEvent =
  | ProviderTextDeltaEvent
  | ProviderToolUseEvent
  | ProviderThinkingEvent
  | ProviderUsageEvent
  | ProviderErrorEvent
  | ProviderDoneEvent
  | ProviderThreadStartedEvent;

/** @deprecated Use ProviderEvent instead */
export interface StreamChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  error?: string;
  usage?: TokenUsage;
}

/** Converts StreamChunk to ProviderEvent[] for legacy parser compatibility */
export function streamChunkToEvents(chunk: StreamChunk): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  switch (chunk.type) {
    case 'delta':
      if (chunk.content) events.push({ type: 'text_delta', text: chunk.content });
      break;
    case 'error':
      events.push({ type: 'error', error: chunk.error ?? 'Unknown error' });
      break;
    case 'done':
      if (chunk.usage) events.push({ type: 'usage', usage: chunk.usage });
      events.push({ type: 'done' });
      break;
  }
  return events;
}

/** Converts ProviderEvent to StreamChunk for legacy consumer compatibility (lossy) */
export function eventToStreamChunk(event: ProviderEvent): StreamChunk | null {
  switch (event.type) {
    case 'text_delta':     return { type: 'delta', content: event.text };
    case 'thinking':       return { type: 'delta', content: event.text };
    case 'error':          return { type: 'error', error: event.error };
    case 'done':           return { type: 'done' };
    case 'tool_use':       return null;
    case 'usage':          return null;
    case 'thread_started': return null;  // Internal event, not emitted over SSE
    default:               return null;
  }
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

// Generic CLI provider configuration for registering custom CLIs from the dashboard.
export interface GenericCliProviderConfig extends PluginProviderConfig {
  prompt_mode: 'stdin' | 'arg';
  prompt_arg_template?: string;  // e.g. ["--", "{prompt}"]
  args_template: string[];       // e.g. ["-m", "{model}", "--format", "json"]
  output_mode: 'plain_text' | 'json_field';
  output_json_content_field?: string;
  streaming_enabled: boolean;
  stream_args_template?: string[];
  stream_content_field?: string;
  stream_done_indicator?: string;
  health_check_args?: string[];
  display_name: string;
  description?: string;
}

// HTTP Provider configuration for OpenAI-compatible APIs
export interface HttpProviderConfig {
  enabled: boolean;
  base_url: string;
  api_key?: string;
  custom_headers?: Record<string, string>;
  default_model: string;
  default_max_tokens?: number; // Default max_tokens when omitted by client (default: 65536)
  max_concurrent: number;
  timeout_ms: number;
  // Serving endpoint type; defaults to 'chat' for legacy compatibility.
  endpoint_type?: EndpointType;
  display_name: string;
  description?: string;
}

export interface ProviderHealthInfo {
  provider: ProviderName;
  status: HealthStatus;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  errorMessage: string | null;
}
