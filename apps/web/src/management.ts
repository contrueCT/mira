import type { MessageEnvelope } from './types.ts';

export const MEMORY_REQUEST_KEY = 'mira.memory-request.v1';
export const MEMORY_REQUEST_PREFIX = '请根据下面的要求补充、纠正或删除你的长期记忆。如果有歧义，请先向我澄清；完成后如实说明结果。\n\n';
export interface MemoryRequestIdentity { id: string; occurredAt: string }
export function createMemoryRequest(text: string): MessageEnvelope {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('请先写下你想修改的记忆');
  const envelope = { id: crypto.randomUUID(), text: `${MEMORY_REQUEST_PREFIX}${trimmed}`, occurredAt: new Date().toISOString() };
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 65_536) throw new Error('修改要求太长，请缩短后再发送（上限约 64 KB）');
  return envelope;
}
export function readMemoryRequest(storage: Pick<Storage, 'getItem'>): MemoryRequestIdentity | null {
  const raw = storage.getItem(MEMORY_REQUEST_KEY);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('无法读取 Memory 请求标识');
  const item = value as Record<string, unknown>;
  if (typeof item['id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(item['id']) || typeof item['occurredAt'] !== 'string' || !Number.isFinite(Date.parse(item['occurredAt']))) throw new Error('无法读取 Memory 请求标识');
  return { id: item['id'], occurredAt: item['occurredAt'] };
}
export function writeMemoryRequest(storage: Pick<Storage, 'setItem'>, request: MemoryRequestIdentity): void {
  // Only the correlation identity belongs here. The immutable message envelope
  // lives in the existing pending queue; credentials and config never do.
  storage.setItem(MEMORY_REQUEST_KEY, JSON.stringify({ id: request.id, occurredAt: request.occurredAt }));
}
export function parseConfig(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('配置必须是有效的完整 JSON 值'); }
  return value;
}

export type MemoryBlock = { kind: 'heading'; level: 1 | 2 | 3; text: string } | { kind: 'paragraph' | 'code'; text: string } | { kind: 'list'; ordered: boolean; items: string[] };
/** A deliberately small block-only subset. Text is never parsed as HTML/links. */
export function memoryBlocks(text: string): MemoryBlock[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MemoryBlock[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { i += 1; continue; }
    if (/^\s*```/u.test(line)) {
      const content: string[] = []; i += 1;
      while (i < lines.length && !/^\s*```/u.test(lines[i]!)) content.push(lines[i++]!);
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', text: content.join('\n') }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, text: heading[2]! }); i += 1; continue; }
    const bullet = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/u.exec(line);
    if (bullet) {
      const ordered = !bullet[1]; const items: string[] = [];
      while (i < lines.length) {
        const next = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/u.exec(lines[i]!);
        if (!next || !next[1] !== ordered) break;
        items.push(next[2]!); i += 1;
      }
      blocks.push({ kind: 'list', ordered, items }); continue;
    }
    const paragraph = [line]; i += 1;
    while (i < lines.length && lines[i]!.trim() && !/^(?:#{1,6}\s|\s*```|\s*(?:[-+*]|\d+[.)])\s)/u.test(lines[i]!)) paragraph.push(lines[i++]!);
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}
