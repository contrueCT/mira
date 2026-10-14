import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RuntimeRecord } from '@mira/context';
import { prepareWakeTurn, type LifeEvent, type LiveInputWriter, type LiveWakeInput, type ToolIntent, type WakeReceipt, type WakeRun } from '@mira/life';
import { MemoryWriter } from './fixtures.mts';

export const userEvent = (id: string, text = id): LifeEvent => ({ id, type: 'web.message', source: 'user', occurredAt: '2026-10-14T00:00:00.000Z', payload: { text } });
export const userWake = (id: string): WakeReceipt => ({ id: `web:${id}`, reason: 'User message from the local web interface' });
export const noOverflow = async () => { throw Error('Unexpected test overflow'); };
/** Deterministic runtime-only fixture. Database atomicity is tested with PG. */
export class LiveMemoryWriter extends MemoryWriter implements LiveInputWriter {
  run: WakeRun = { id: randomUUID(), claimedAt: '2026-10-14T00:00:00.000Z', status: 'running', inputRecordId: null, finalRecordId: null,
    requests: [{ eventId: randomUUID(), event: userEvent('original'), wake: userWake('original') }] };
  live: LiveWakeInput[] = [];
  listeners = new Set<(id: string) => void>();
  beforeFinal?: () => Promise<void>;
  claimWakeBatch = async () => structuredClone(this.run.status === 'running' ? this.run : null);
  loadWakeRun = async () => structuredClone(this.run);
  loadLiveInputs = async () => structuredClone(this.live);
  turn = () => prepareWakeTurn(this.run, noOverflow, 65_536);
  onLiveInput(listener: (id: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async receiveLiveInput(event: LifeEvent, wake: WakeReceipt): Promise<'inserted' | 'duplicate'> {
    const old = this.live.find(item => item.request.event.id === event.id);
    if (old) { assert.deepEqual(old.request.event, event); assert.deepEqual(old.request.wake, wake); return 'duplicate'; }
    assert.equal(this.run.finalRecordId, null);
    this.live.push({ request: { eventId: randomUUID(), event: structuredClone(event), wake: structuredClone(wake) }, inputRecordId: null });
    for (const listener of this.listeners) listener(this.run.id);
    return 'inserted';
  }
  async appendWakeInput(_id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    assert.equal(this.run.inputRecordId, null); const next = await this.append(version, record, signal); this.run.inputRecordId = record.id; return next;
  }
  async appendLiveInput(_id: string, wakeId: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    const first = this.live.find(item => !item.inputRecordId); assert.equal(first?.request.wake.id, wakeId);
    const next = await this.append(version, record, signal); first!.inputRecordId = record.id; return next;
  }
  async tryBeginWakeTool(_id: string, version: number, intent: ToolIntent) {
    if (this.live.some(item => !item.inputRecordId)) return false;
    await this.beginTool(version, intent); return true;
  }
  async tryAppendWakeFinal(id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    await this.beforeFinal?.();
    if (this.live.some(item => !item.inputRecordId)) return null;
    return this.appendWakeFinal(id, version, record, signal);
  }
  async appendWakeFinal(_id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    assert.equal(this.run.finalRecordId, null); const next = await this.append(version, record, signal); this.run.finalRecordId = record.id; return next;
  }
  async completeWakeRun() { assert.ok(this.run.finalRecordId); this.run.status = 'completed'; }
}
