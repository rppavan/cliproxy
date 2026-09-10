// Splits thinking content from final answers in reasoning model outputs.
// Handles four cases across reasoning backends:
// 1. Separate field: message.reasoning_content (handled upstream by provider)
// 2. Standard markers: "<think>thinking</think>\n\nanswer"
// 3. Missing opening tag (e.g. Qwen3/DeepSeek-R1 chat_template prefix absorption): "thinking</think>\n\nanswer"
// 4. No markers: standard answer

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface SplitResult {
  reasoning: string;
  content: string;
}

// Guard against false positives when </think> appears as literal text in the body.
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Split completed content into reasoning and answer for non-streaming responses.
 * Safeguard: only splits when exactly one </think> marker exists to avoid false positives on literal text.
 */
export function splitReasoning(raw: string): SplitResult {
  if (!raw) return { reasoning: '', content: '' };

  const closeCount = countOccurrences(raw, CLOSE_TAG);
  if (closeCount !== 1) {
    return { reasoning: '', content: raw };
  }

  const closeIdx = raw.indexOf(CLOSE_TAG);
  let beforeClose = raw.slice(0, closeIdx);
  const afterClose = raw.slice(closeIdx + CLOSE_TAG.length);

  // Strip opening tag if present (handles cases where chat_template absorbs prefix).
  const openIdx = beforeClose.indexOf(OPEN_TAG);
  if (openIdx !== -1) {
    beforeClose = beforeClose.slice(openIdx + OPEN_TAG.length);
  }

  return {
    reasoning: beforeClose.replace(/^\s+|\s+$/g, ''),
    content: afterClose.replace(/^\s+/, ''),
  };
}

/**
 * Incrementally split streaming reasoning responses.
 * Buffers trailing characters to safely handle partial closing tokens (e.g. "</thi") across stream chunks.
 */
export class ReasoningSplitter {
  private mode: 'thinking' | 'content' = 'thinking';
  private buffer = '';
  private seenAnyToken = false;

  push(delta: string): { reasoning: string; content: string } {
    if (!delta) return { reasoning: '', content: '' };

    if (!this.seenAnyToken) {
      this.seenAnyToken = true;
      if (delta.startsWith(OPEN_TAG)) {
        delta = delta.slice(OPEN_TAG.length);
      }
    }

    this.buffer += delta;

    if (this.mode === 'content') {
      const out = this.buffer;
      this.buffer = '';
      return { reasoning: '', content: out };
    }

    const closeIdx = this.buffer.indexOf(CLOSE_TAG);
    if (closeIdx !== -1) {
      const reasoning = this.buffer.slice(0, closeIdx);
      const trailing = this.buffer.slice(closeIdx + CLOSE_TAG.length);
      this.buffer = '';
      this.mode = 'content';
      return {
        reasoning,
        content: trailing.replace(/^\s+/, ''),
      };
    }

    // Hold back trailing characters to prevent emitting partial closing tags before the next chunk arrives.
    const safeLen = Math.max(this.buffer.length - (CLOSE_TAG.length - 1), 0);
    if (safeLen === 0) {
      return { reasoning: '', content: '' };
    }
    const safe = this.buffer.slice(0, safeLen);
    this.buffer = this.buffer.slice(safeLen);
    return { reasoning: safe, content: '' };
  }

  /** Flush remaining buffered tokens at the end of stream. */
  flush(): { reasoning: string; content: string } {
    const tail = this.buffer;
    this.buffer = '';
    if (!tail) return { reasoning: '', content: '' };
    return this.mode === 'thinking'
      ? { reasoning: tail, content: '' }
      : { reasoning: '', content: tail };
  }

  get isInThinking(): boolean {
    return this.mode === 'thinking';
  }
}
