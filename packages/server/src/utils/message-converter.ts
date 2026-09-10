import type { ChatMessage, ChatMessageContent, ChatMessageContentPart } from '@star-cliproxy/shared';

export interface ConvertedPrompt {
  systemPrompt: string | null;
  userPrompt: string;
}

// Prevent prompt injection by escaping internal delimiter patterns with lookalike characters.
export function sanitizeDelimiters(content: string): string {
  return content
    .replace(/<\|user\|>/g, '<​user​>')
    .replace(/<\|assistant\|>/g, '<​assistant​>')
    .replace(/<\|system\|>/g, '<​system​>');
}

// Identify image blocks across OpenAI Chat Completions, Responses API, and Anthropic formats.
export function isImagePart(part: ChatMessageContentPart): boolean {
  const t = part?.type;
  return t === 'image_url' || t === 'input_image' || t === 'image';
}

// Extract text from multimodal content; replace image blocks with [image] markers to preserve positional layout.
export function extractTextFromContent(content: ChatMessageContent | undefined | null): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (isImagePart(part)) {
      parts.push('[image]');
      continue;
    }
    if (typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

export function convertMessages(messages: ChatMessage[]): ConvertedPrompt {
  let systemPrompt: string | null = null;
  const conversationParts: string[] = [];

  for (const msg of messages) {
    const content = extractTextFromContent(msg.content);
    if (msg.role === 'system') {
      systemPrompt = content;
    } else if (msg.role === 'user') {
      conversationParts.push(`<|user|> ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'assistant') {
      conversationParts.push(`<|assistant|> ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'tool') {
      // Convert tool results to user messages because CLI providers lack native tool role support.
      const toolName = msg.name ?? 'tool';
      conversationParts.push(`<|user|> [Tool result ${sanitizeDelimiters(toolName)}] ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'developer') {
      // Treat developer role as system prompt (OpenAI o1/o3 convention).
      systemPrompt = content;
    }
  }

  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  if (nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user') {
    return {
      systemPrompt,
      userPrompt: extractTextFromContent(nonSystemMessages[0].content),
    };
  }

  return {
    systemPrompt,
    userPrompt: conversationParts.join('\n\n'),
  };
}

export function convertMessagesToSinglePrompt(messages: ChatMessage[]): string {
  const { systemPrompt, userPrompt } = convertMessages(messages);

  if (systemPrompt) {
    return `<|system|> ${systemPrompt}\n\n${userPrompt}`;
  }

  return userPrompt;
}
