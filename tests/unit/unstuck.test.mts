import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { HistoryEntry, LifeEvent, WakeReceipt } from '@mira/life';
import { ExtensionHost } from '@mira/extension-host';
import { encodeEntry, messageEntry } from '@mira/runtime-pi';
import { extensionManagementTools } from '@mira/server';
import { isNoReply, visible } from '../../apps/server/src/web-service.ts';
import { BackgroundJobs, backgroundResultId } from '../../apps/server/src/background-jobs.ts';
import { TerminalManager, type TerminalExit } from '../../apps/server/src/terminals.ts';
import { assistant, toolCalls } from '../recovery/fixtures.mts';

const context = (message: ReturnType<typeof assistant>): HistoryEntry => {
  const record = encodeEntry(messageEntry(message, null));
  return { kind: 'context', id: record.id, occurredAt: record.occurredAt, record } as unknown as HistoryEntry;
};

test('only a final whose whole text is NO_REPLY is hidden from the chat', () => {
  assert.equal(visible(context(assistant('NO_REPLY'))), null);
  assert.equal(visible(context(assistant('  NO_REPLY\n'))), null);
  assert.equal(isNoReply(assistant('NO_REPLY')), true);
  for (const text of ['NO_REPLY.', 'no_reply', 'NO_REPLY because nothing to add', '好的']) {
    assert.equal(isNoReply(assistant(text)), false, text);
    assert.equal(visible(context(assistant(text)))?.text, text);
  }
  const call = { ...toolCalls('x'), content: [{ type: 'text' as const, text: 'NO_REPLY' }, ...toolCalls('x').content] };
  assert.equal(isNoReply(call), false, 'a tool-calling turn is not a final');
  assert.equal(isNoReply({ ...assistant('NO_REPLY'), stopReason: 'error' }), false);
});

class EventWriter {
  readonly events: Array<{ event: LifeEvent; wake?: WakeReceipt }> = [];
  readonly signal = new AbortController().signal;
  async receive(event: LifeEvent, wake?: WakeReceipt) {
    if (this.events.some(item => item.event.id === event.id)) return 'duplicate' as const;
    this.events.push({ event, ...(wake ? { wake } : {}) }); return 'inserted' as const;
  }
  async pendingBackgroundJobs() {
    return this.events.filter(item => item.event.type === 'tool.background.started'
      && !this.events.some(other => other.event.id === backgroundResultId((item.event.payload as { jobId: string }).jobId))).map(item => item.event);
  }
}

test('background jobs record start (non-waking), one settled event that wakes, and lost-on-restart without replay', async () => {
  const writer = new EventWriter(); let kicks = 0; const owner = new AbortController();
  const jobs = new BackgroundJobs({ writer: writer as never, signal: owner.signal, kick: () => { kicks++; }, subagents: () => [{ id: "11111111-1111-4111-8111-111111111111", title: "Build", runningForMs: 120_000, idleForMs: 5_000 }, { id: "22222222-2222-4222-8222-222222222222", title: null, runningForMs: 60_000, idleForMs: 60_000 }] });
  const options = jobs.foreground();
  assert.equal(options.hardLimitMs, 300_000); assert.equal(options.steerGraceMs, 20_000);
  assert.equal(options.promotable!('send_reply'), false); assert.equal(options.promotable!('exec_command'), true);
  const job = { jobId: '11111111-1111-4111-8111-111111111111', callId: 'call', toolName: 'bash', startedAt: new Date(Date.now() - 65_000).toISOString(), backgroundedAt: new Date().toISOString(), reason: 'user-input' as const };
  await options.onBackground(job);
  assert.equal(writer.events[0]!.event.type, 'tool.background.started'); assert.equal(writer.events[0]!.wake, undefined);
  const status = jobs.status({ phase: 'live', wakeStartedAt: new Date(Date.now() - 120_000).toISOString() })!;
  assert.match(status, /nothing was cancelled/); assert.match(status, /bash \(job 1111/); assert.match(status, /Subagents running: 2/);
  assert.equal(jobs.status({ phase: 'initial', wakeStartedAt: new Date().toISOString() })?.includes('bash'), true);
  // A second process sees the unfinished job as lost.
  const restarted = new BackgroundJobs({ writer: writer as never, signal: owner.signal, kick: () => { kicks++; } });
  assert.equal(await restarted.recoverLost(), 1);
  const lost = writer.events.at(-1)!;
  assert.equal(lost.event.type, 'tool.background.lost'); assert.equal(lost.event.id, backgroundResultId(job.jobId)); assert.ok(lost.wake);
  assert.match(JSON.stringify(lost.event.payload), /outcome is unknown and it was not re-run/);
  assert.equal(await restarted.recoverLost(), 0, 'lost is recorded once');
  // A late settle for the same job id is a duplicate and does not wake again.
  await options.onSettled(job, { status: 'completed', result: { content: [{ type: 'text', text: 'ok' }], details: {} } });
  assert.equal(kicks, 0);
  const initial = jobs.status({ phase: 'initial', wakeStartedAt: new Date().toISOString() })!;
  // ADR 0051: one compact line per running child, model-only.
  assert.deepEqual(initial.split('\n'), ['Subagents running: 2.', '- Build (11111111-1111-4111-8111-111111111111) · running 2 min · idle 5 s', '- 22222222 (22222222-2222-4222-8222-222222222222) · running 1 min · idle 1 min']);
  const other = { ...job, jobId: '22222222-2222-4222-8222-222222222222' };
  await options.onBackground(other);
  await options.onSettled(other, { status: 'completed', result: { content: [{ type: 'text', text: 'x'.repeat(20_000) }], details: {} } });
  const settled = writer.events.at(-1)!;
  assert.equal(settled.event.type, 'tool.background.settled'); assert.ok(settled.wake); assert.equal(kicks, 1);
  assert.equal((settled.event.payload as { truncated: boolean }).truncated, true);
});

test('a hung context provider times out for this request instead of holding the model', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-provider-timeout-'));
  const file = path.join(root, 'extension.mjs');
  await writeFile(file, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
    export default defineExtension({ name: 'slow', apply(ctx) { ctx.registerContextProvider({ id: 'slow', provide() { return new Promise(resolve => setTimeout(() => resolve({ text: 'late' }), 600)); } }); } });`);
  const host = new ExtensionHost({ entries: [{ id: 'slow', path: pathToFileURL(file).pathname }], contextProviderTimeoutMs: 50, receive: async () => 'inserted' });
  t.after(async () => { await host.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await host.start();
  const prepared = await host.prepareCapabilities();
  const started = Date.now();
  const [sample] = await host.sampleContextProviders(prepared.contextProviders, new AbortController().signal);
  assert.equal(sample!.status, 'timeout'); assert.ok(Date.now() - started < 2_000);
});

test('extension_manage reports pending after its bound and never claims an outcome', async () => {
  let settle!: (value: unknown) => void;
  const host = { requestChange: () => new Promise(resolve => { settle = resolve; }) };
  const manage = extensionManagementTools(host as never, undefined, { manageTimeoutMs: 30 }).find(tool => tool.name === 'extension_manage')!;
  const result = await manage.execute('call', { id: 'fixture', action: 'enable' });
  const body = JSON.parse((result.content[0] as { text: string }).text) as { status: string; note: string };
  assert.equal(body.status, 'pending'); assert.match(body.note, /not confirmed/);
  settle({});
});

test('exec_command notify_on_exit reports a process that outlived its launch call, once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-exit-notify-'));
  let n = 0; const exits: TerminalExit[] = [];
  const manager = new TerminalManager({ cwd: root, onExit: exit => exits.push(exit), writeOverflowInput: async (_id, content) => {
    const file = path.join(root, `chunk-${n++}`); await writeFile(file, content); return { path: file, bytes: Buffer.byteLength(content) };
  } });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const long = await manager.exec('main', { command: 'sleep 0.3; echo done', yield_ms: 0, notify_on_exit: true });
  assert.equal(long.status, 'running');
  const quick = await manager.exec('main', { command: 'true', yield_ms: 3000, notify_on_exit: true });
  assert.notEqual(quick.status, 'running');
  for (let i = 0; i < 200 && !exits.length; i++) await delay(10);
  await delay(200);
  assert.equal(exits.length, 1, 'only the process still running at launch return is reported');
  assert.equal(exits[0]!.sessionId, long.session_id); assert.equal(exits[0]!.exitCode, 0); assert.equal(exits[0]!.status, 'exited');
});
