import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_REQUEST_KEY } from '../src/management.ts';
import { busyText, clearLifeStorage, confirmReady, formatBytes, impactRows, isBusy, LIFE_KEY, observeLife, type ResetPreview } from '../src/memory-reset.ts';
import { PENDING_KEY } from '../src/timeline.ts';

class MemoryStorage implements Storage {
  #values = new Map<string, string>();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key: string) { return this.#values.get(key) ?? null; }
  key(index: number) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string) { this.#values.delete(key); }
  setItem(key: string, value: string) { this.#values.set(key, value); }
}
const preview = (overrides: Partial<ResetPreview> = {}): ResetPreview => ({
  scope: 'life', lifeId: 'mira', persona: { name: '小满', custom: true },
  impact: { memoryFiles: 14, memoryBytes: 23 * 1024, compactions: 6, messages: 1286, pendingWakes: 0, pendingDeliveries: 2 },
  busy: { running: false, subagents: 0 }, token: 't', expiresAt: '2026-10-30T00:02:00Z', archivePath: '/home/u/.mira/archive/mira-2026-10-30T000000Z', ...overrides,
});

test('the confirm button only unlocks on the exact typed word', () => {
  assert.equal(confirmReady(''), false);
  assert.equal(confirmReady('重'), false);
  assert.equal(confirmReady(' 重置'), false);
  assert.equal(confirmReady('重置 '), false);
  assert.equal(confirmReady('reset'), false);
  assert.equal(confirmReady('重置'), true);
});

test('impact rows describe what each scope archives, clears or keeps', () => {
  const life = impactRows(preview(), 'life');
  assert.deepEqual(life.map(row => [row.label, row.value, row.kind]), [
    ['长期记忆文件', '14 个 · 23 KB → 归档', 'gone'],
    ['工作上下文与 6 次压缩摘要', '归档', 'gone'],
    ['聊天记录（界面不再显示）', '1,286 条 → 归档', 'gone'],
    ['排队中的唤醒 / 定时任务', '0 / 2 → 取消', 'gone'],
    ['人设、模型、扩展、访问密码、附件文件', '保留', 'kept'],
  ]);
  const memory = impactRows(preview({ scope: 'memory', archivePath: null }), 'memory');
  assert.equal(memory[0]?.value, '14 个 · 23 KB → 清空（可回退）');
  assert.deepEqual(memory.slice(1).map(row => row.kind), ['kept', 'kept', 'kept', 'kept']);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('busy copy is honest per scope and uses the persona name', () => {
  assert.equal(busyText(preview(), 'life'), null);
  const busy = preview({ busy: { running: true, subagents: 1 } });
  assert.equal(isBusy(busy), true);
  assert.equal(busyText(busy, 'life'), '小满正在处理一个任务（子任务 1 个运行中）。确认后会先停止当前工作；已经开始的操作不会被撤销。');
  assert.match(busyText(busy, 'memory') ?? '', /清空记忆后小满会接着处理这个未完成的任务/u);
  assert.equal(isBusy(preview({ busy: { running: false, subagents: 2 } })), true);
});

test('a life change clears this tab’s old-life envelopes, Memory request and dismissed error', () => {
  const storage = new MemoryStorage();
  assert.equal(observeLife(storage, undefined), 'same');
  assert.equal(observeLife(storage, 'mira'), 'same');
  assert.equal(storage.getItem(LIFE_KEY), 'mira');
  storage.setItem(PENDING_KEY, '[]'); storage.setItem(MEMORY_REQUEST_KEY, '{}'); storage.setItem('mira.dismissedErrorId', 'e'); storage.setItem('other', 'kept');
  assert.equal(observeLife(storage, 'mira'), 'same');
  assert.equal(storage.getItem(PENDING_KEY), '[]');
  assert.equal(observeLife(storage, 'mira~g1'), 'changed');
  assert.equal(storage.getItem(LIFE_KEY), 'mira~g1');
  for (const key of [PENDING_KEY, MEMORY_REQUEST_KEY, 'mira.dismissedErrorId']) assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem('other'), 'kept');
  storage.setItem(PENDING_KEY, '[]');
  clearLifeStorage(storage);
  assert.equal(storage.getItem(PENDING_KEY), null);
});
