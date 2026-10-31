import { PENDING_KEY } from './timeline.ts';
import { MEMORY_REQUEST_KEY } from './management.ts';

export type ResetScope = 'memory' | 'life';
export type ResetState = 'stopping' | 'archiving' | 'starting' | 'completed' | 'failed';
export interface ResetPreview {
  scope: ResetScope; lifeId: string; persona: { name: string; custom: boolean };
  impact: { memoryFiles: number; memoryBytes: number; compactions: number; messages: number; pendingWakes: number; pendingDeliveries: number };
  busy: { running: boolean; subagents: number }; token: string; expiresAt: string; archivePath: string | null;
}
export interface ResetStatus { id: string; scope: ResetScope; state: ResetState; lifeId: string | null; archivePath: string | null; commit: string | null; error: string | null }
export interface ImpactRow { label: string; value: string; kind: 'gone' | 'kept' }

/** The exact word the server also requires; no trimming or look-alikes. */
export const RESET_WORD = '重置';
export const confirmReady = (typed: string) => typed === RESET_WORD;
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const number = new Intl.NumberFormat('zh-CN');
/** What the chosen scope does to each kind of data, as the dialog lists it. */
export function impactRows(preview: ResetPreview, scope: ResetScope): ImpactRow[] {
  const { impact } = preview;
  const files = `${number.format(impact.memoryFiles)} 个 · ${formatBytes(impact.memoryBytes)}`;
  if (scope === 'memory') return [
    { label: '长期记忆文件', value: `${files} → 清空（可回退）`, kind: 'gone' },
    { label: `工作上下文与 ${number.format(impact.compactions)} 次压缩摘要`, value: '保留', kind: 'kept' },
    { label: '聊天记录', value: `${number.format(impact.messages)} 条 · 保留`, kind: 'kept' },
    { label: '排队中的唤醒 / 定时任务', value: '保留', kind: 'kept' },
    { label: '人设、模型、扩展、访问密码、附件文件', value: '保留', kind: 'kept' },
  ];
  return [
    { label: '长期记忆文件', value: `${files} → 归档`, kind: 'gone' },
    { label: `工作上下文与 ${number.format(impact.compactions)} 次压缩摘要`, value: '归档', kind: 'gone' },
    { label: '聊天记录（界面不再显示）', value: `${number.format(impact.messages)} 条 → 归档`, kind: 'gone' },
    { label: '排队中的唤醒 / 定时任务', value: `${number.format(impact.pendingWakes)} / ${number.format(impact.pendingDeliveries)} → 取消`, kind: 'gone' },
    { label: '人设、模型、扩展、访问密码、附件文件', value: '保留', kind: 'kept' },
  ];
}
export const isBusy = (preview: ResetPreview | null) => !!preview && (preview.busy.running || preview.busy.subagents > 0);
/** An honest note: stopping never undoes effects that already started. */
export function busyText(preview: ResetPreview, scope: ResetScope): string | null {
  if (!isBusy(preview)) return null;
  const name = preview.persona.name;
  const children = preview.busy.subagents > 0 ? `（子任务 ${preview.busy.subagents} 个运行中）` : '';
  return scope === 'life'
    ? `${name}正在处理一个任务${children}。确认后会先停止当前工作；已经开始的操作不会被撤销。`
    : `${name}正在处理一个任务${children}。确认后会先停止当前工作，清空记忆后${name}会接着处理这个未完成的任务；已经开始的操作不会被撤销。`;
}
export function progressText(state: ResetState, scope: ResetScope): string {
  return ({ stopping: '正在停止当前工作…', archiving: scope === 'life' ? '正在归档旧数据…' : '正在清空长期记忆…', starting: '正在重新启动…', completed: '已完成', failed: '重置未完成' } as const)[state];
}
export const LIFE_KEY = 'mira.life-id.v1';
/** Browser-held state that belongs to one life: unconfirmed envelopes, the
 * pending Memory request and dismissed errors. A new life starts clean. */
export function clearLifeStorage(storage: Storage): void {
  for (const key of [PENDING_KEY, MEMORY_REQUEST_KEY, 'mira.dismissedErrorId']) storage.removeItem(key);
}
/** Record the server's life ID; 'changed' means this tab held another life. */
export function observeLife(storage: Storage, lifeId: string | undefined): 'same' | 'changed' {
  if (!lifeId) return 'same';
  const known = storage.getItem(LIFE_KEY);
  if (known === lifeId) return 'same';
  storage.setItem(LIFE_KEY, lifeId);
  if (known === null) return 'same';
  clearLifeStorage(storage);
  return 'changed';
}
