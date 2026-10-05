/** JSON only: runtime adapters validate and interpret their own payloads. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RuntimeRecord {
  formatVersion: 1;
  runtime: string;
  runtimeVersion: string;
  id: string;
  parentId: string | null;
  kind: 'message' | 'checkpoint';
  occurredAt: string;
  payload: Json;
}
export interface ContextSnapshot {
  miraId: string;
  version: number;
  records: RuntimeRecord[];
}
export function assertJson(value: unknown): asserts value is Json {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new Error('Expected finite, acyclic JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Expected plain JSON object');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('JSON cannot contain symbol keys');
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).some((present) => !present))) throw new Error('JSON arrays must be dense and have no extra properties');
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  };
  visit(value);
}
export function assertRecord(value: unknown): asserts value is RuntimeRecord {
  assertJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runtime record');
  if (value['formatVersion'] !== 1) throw new Error('Unsupported envelope version: explicit migration required');
  const text = (key: string): boolean => typeof value[key] === 'string' && value[key].length > 0;
  if (!text('id') || !text('runtime') || !text('runtimeVersion') ||
      (value['parentId'] !== null && !text('parentId')) ||
      (value['kind'] !== 'message' && value['kind'] !== 'checkpoint') ||
      !text('occurredAt') || !Number.isFinite(Date.parse(value['occurredAt'] as string)) ||
      !Object.hasOwn(value, 'payload')) throw new Error('Invalid runtime record');
}
