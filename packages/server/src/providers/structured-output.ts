import type { ChatResponseFormat } from '@star-cliproxy/shared';

/**
 * Common helper for structured output (OpenAI `response_format`) across CLI providers.
 *
 * Although each CLI receives schemas differently (agy/claude/grok accept `--json-schema` args,
 * while codex accepts `--output-schema <path>` files), the following rules apply uniformly:
 *  - Pass only the nested schema to the CLI, omitting the OpenAI wrapper (name/strict).
 *  - Treat the CLI structured output field as the source of truth; fail rather than falling back to raw text.
 *  - Suppress intermediate streaming deltas when schema enforcement is requested (see comments below).
 */

/** Checks if the request requires schema enforcement. Excludes json_object/text since CLIs cannot enforce them. */
export function wantsSchemaEnforcement(
  format: ChatResponseFormat | undefined,
): format is Extract<ChatResponseFormat, { type: 'json_schema' }> {
  return format?.type === 'json_schema';
}

/** Serialized JSON Schema string to pass to CLI, or undefined if schema enforcement is not requested. */
export function schemaArgument(format: ChatResponseFormat | undefined): string | undefined {
  return wantsSchemaEnforcement(format) ? JSON.stringify(format.json_schema.schema) : undefined;
}

/**
 * Serializes the CLI structured output value into a JSON string for OpenAI `message.content`.
 *
 * Throws an error rather than falling back to raw text if the field is missing — failing fast allows
 * failover routing to engage rather than misleading clients with schema-violating prose.
 * (Observed behavior: agy's `response` field may mix prose with non-schema fields even when given a schema.)
 */
export function requireStructuredOutput(value: unknown, cliLabel: string, fieldName: string): string {
  if (value === undefined || value === null) {
    throw new Error(
      `${cliLabel} CLI did not return ${fieldName} (response_format=json_schema). ` +
      `Check if this CLI version supports schema enforcement.`,
    );
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Determines whether streaming deltas should be buffered during schema enforcement requests.
 *
 * Always true — real-world CLI streaming behaviors vary widely across providers:
 *  - agy: emits prose deltas first ("Blue") before emitting JSON with non-schema fields at the end
 *  - claude: emits prose deltas before generating final schema-compliant values via internal StructuredOutput tool calls
 *  - grok: emits valid incremental JSON tokens, but differs from other CLIs
 *
 * To provide uniform client behavior across providers, schema requests always emit a single completed structured value.
 */
export function shouldBufferStream(format: ChatResponseFormat | undefined): boolean {
  return wantsSchemaEnforcement(format);
}
