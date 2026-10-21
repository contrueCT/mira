/** Bounded reductions for a compaction summary request that does not fit.
 * Codex drops the oldest history items and retries; dsh prunes tool results
 * before summarizing. Mira first bounds the reference-only retained tail, then
 * trims tool results with head+tail excerpts, then omits the oldest source
 * messages. Every reduction is declared to the summarizer in the request. */
type Json = Record<string, unknown>;
export interface CompactionRequestInput extends Json {
  source_messages: Json[];
  retained_tail: { purpose: string; messages: Json[] } & Json;
}

/** Keep head and tail of oversized text with an explicit omission marker. */
export function clipMiddle(text: string, maxCharacters: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  const half = Math.max(1, Math.floor(maxCharacters / 2));
  return `${characters.slice(0, half).join('')}\n[… ${characters.length - half * 2} characters omitted for compaction …]\n${characters.slice(-half).join('')}`;
}
function clipMessage(message: Json, maxCharacters: number): { message: Json; clipped: boolean } {
  const content = message['content'];
  if (typeof content === 'string') {
    const next = clipMiddle(content, maxCharacters);
    return { message: { ...message, content: next }, clipped: next !== content };
  }
  if (!Array.isArray(content)) return { message, clipped: false };
  let clipped = false;
  const blocks = content.map((block: Json) => {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      const next = clipMiddle(block['text'], maxCharacters);
      if (next !== block['text']) { clipped = true; return { ...block, text: next }; }
    }
    if (block['type'] === 'toolCall' && block['arguments'] !== undefined) {
      const raw = JSON.stringify(block['arguments']);
      if (raw.length > maxCharacters) { clipped = true; return { ...block, arguments: { omitted_for_compaction: true, excerpt: clipMiddle(raw, maxCharacters) } }; }
    }
    return block;
  });
  return { message: { ...message, content: blocks }, clipped };
}
const size = (value: unknown) => JSON.stringify(value).length;

/** Reference-only tail: newest messages first within a character budget, each
 * clipped to an excerpt. Returns the input unchanged when already within it. */
export function boundRetainedTail(input: CompactionRequestInput, maxCharacters: number, excerptCharacters = 2_000): CompactionRequestInput {
  if (size(input.retained_tail.messages) <= maxCharacters) return input;
  const kept: Json[] = []; let used = 0;
  for (const message of [...input.retained_tail.messages].reverse()) {
    const { message: excerpt } = clipMessage(message, excerptCharacters);
    const cost = size(excerpt);
    if (kept.length && used + cost > maxCharacters) break;
    kept.unshift(excerpt); used += cost;
  }
  const omitted = input.retained_tail.messages.length - kept.length;
  return { ...input, retained_tail: { ...input.retained_tail, messages: kept, excerpted: true, ...(omitted ? { omitted_older_messages: omitted } : {}) } };
}

/** Successively smaller request inputs, starting with the unchanged one. */
export function* compactionReductions(input: CompactionRequestInput, contextCharacters: number): Generator<{ input: CompactionRequestInput; reductions: string[] }> {
  yield { input, reductions: [] };
  const reductions: string[] = [];
  // Bound the reference-only tail to about a tenth of the window.
  let current = boundRetainedTail(input, Math.max(4_000, Math.floor(contextCharacters * 0.1)));
  if (current !== input) { reductions.push('retained_tail_excerpted'); yield { input: withReductions(current, reductions), reductions: [...reductions] }; }
  for (const limit of [8_000, 2_000, 500]) {
    let trimmed = 0;
    const messages = current.source_messages.map(message => {
      if (message['role'] !== 'toolResult') return message;
      const result = clipMessage(message, limit); if (result.clipped) trimmed++;
      return result.message;
    });
    if (!trimmed) continue;
    current = { ...current, source_messages: messages };
    reductions.push(`tool_results_trimmed_to_${limit}_characters:${trimmed}`);
    yield { input: withReductions(current, [...reductions]), reductions: [...reductions] };
  }
  // Then omit the oldest source messages, halving what remains each step and
  // always keeping at least the newest one. Their IDs remain in the boundary.
  let omitted = 0;
  while (current.source_messages.length > 1) {
    const drop = Math.max(1, Math.floor(current.source_messages.length / 2));
    omitted += drop;
    current = { ...current, source_messages: current.source_messages.slice(drop) };
    const steps = [...reductions, `oldest_source_messages_omitted:${omitted}`];
    yield { input: withReductions(current, steps), reductions: steps };
  }
}
function withReductions(input: CompactionRequestInput, reductions: string[]): CompactionRequestInput {
  return { ...input, input_reductions: { notice: 'This request was reduced to fit the model context window. Summarize only what is present; state that earlier details were omitted when relevant and do not invent them.', steps: reductions } };
}
