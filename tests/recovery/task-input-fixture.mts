import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RuntimeRecord } from '@mira/context';
import type { TaskInputWriter, TaskTurnState, TaskLiveInput, ToolIntent } from '@mira/life';
import { MemoryWriter } from './fixtures.mts';

/** Offline adapter fixture, never production storage or evidence of PG locking. */
export class TaskMemoryWriter extends MemoryWriter implements TaskInputWriter {
  task: TaskTurnState = { id: randomUUID(), callId: 'original-assignment', createdAt: new Date().toISOString(), status: 'running', inputRecordId: null, finalRecordId: null };
  inputs: TaskLiveInput[] = [];
  listeners = new Set<(id: string) => void>();
  beforeFinal?: () => Promise<void>;
  onInput = (listener: (id: string) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  add(callId: string, instruction = callId) {
    const old = this.inputs.find(value => value.callId === callId);
    if (old) { assert.equal(old.instruction, instruction); return; }
    assert.equal(this.task.finalRecordId, null); assert.equal(this.task.status, 'running');
    this.inputs.push({ callId, instruction, createdAt: new Date().toISOString(), inputRecordId: null });
    for (const notify of this.listeners) notify(this.task.id);
  }
  private active(id: string) { assert.equal(id, this.task.id); assert.equal(this.task.status, 'running'); assert.equal(this.task.finalRecordId, null); }
  async loadTaskTurn(id: string) { assert.equal(id, this.task.id); return structuredClone(this.task); }
  async loadTaskInputs(id: string) { assert.equal(id, this.task.id); return structuredClone(this.inputs); }
  async appendTaskInput(id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.active(id); assert.equal(this.task.inputRecordId, null);
    const next = await this.append(version, record, signal); this.task.inputRecordId = record.id; return next;
  }
  async appendTaskLiveInput(id: string, callId: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.active(id); const first = this.inputs.find(value => !value.inputRecordId)!; assert.equal(first.callId, callId);
    const next = await this.append(version, record, signal); first.inputRecordId = record.id; return next;
  }
  async tryBeginTaskTool(id: string, version: number, intent: ToolIntent) {
    this.active(id); if (this.inputs.some(value => !value.inputRecordId)) return false;
    await this.beginTool(version, intent); return true;
  }
  async tryAppendTaskFinal(id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.active(id); await this.beforeFinal?.();
    if (this.inputs.some(value => !value.inputRecordId)) return null;
    const next = await this.append(version, record, signal); this.task.finalRecordId = record.id; return next;
  }
}
