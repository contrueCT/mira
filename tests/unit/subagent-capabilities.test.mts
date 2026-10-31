import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ExtensionHost, readExtensionConfiguration, runDelegated, type ExtensionHostOptions, type RegisteredTool } from '@mira/extension-host';
import type { ExtensionContext } from '@mira/extension-sdk';
import { subagentCompletionPayload, type SubagentTurn } from '@mira/life';
import { snapshotTool } from '../../packages/extension-host/src/toolsets.ts';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { capabilityProblem, delegatedExtensionTools } from '../../apps/server/src/subagent-capabilities.ts';
import { model } from '../recovery/fixtures.mts';

// ADR 0052 offline checks. Real PostgreSQL/service flows are in
// tests/recovery/subagent-reports.test.mts.
const TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const registered = (extensionId: string, name: string, mainOnly = false, execute: RegisteredTool['tool']['execute'] = async () => ({ text: name })): RegisteredTool =>
  ({ extensionId, activation: `${extensionId}-1`, tool: { name, description: name, parameters: { type: 'object' }, execute, ...(mainOnly ? { mainOnly: true } : {}) } });

test('every subagent tool name, main and child side, uses only letters, digits, underscore and hyphen', () => {
  const manager = new SubagentManager({ writer: {} as never, acquire: async () => { throw Error('unused'); }, tools: () => [], writeOverflowInput: async () => { throw Error('unused'); }, onCompletion: () => {}, onFailure: () => {} });
  const main = createSubagentTools(manager, { model, streamFn: (() => { throw Error('unused'); }) as never });
  assert.deepEqual(main.map(tool => tool.name).sort(), ['subagent_cancel', 'subagent_close', 'subagent_send', 'subagent_spawn', 'subagent_status', 'subagent_wait']);
  const child = delegatedExtensionTools([registered('mcp', 'lookup-v2'), registered('mcp', 'notify', true)], ['mcp']);
  for (const name of [...main.map(tool => tool.name), ...child.map(tool => tool.name), 'task_report', 'report_progress']) assert.match(name, TOOL_NAME);
  // Extension tool names with a dot are refused at registration, so none can reach a child.
  for (const name of ['feishu.send', 'a.b', 'x y']) assert.throws(() => snapshotTool({ name, description: 'd', parameters: { type: 'object' }, execute: async () => ({ text: '' }) }), /Invalid extension tool name/);
});

test('delegated extension tools keep only named, non-mainOnly tools and report unusable capabilities', async () => {
  const registry = [registered('mcp', 'lookup'), registered('mcp', 'notify', true), registered('feishu', 'feishu_send_message', true), registered('other', 'other_tool')];
  assert.deepEqual(delegatedExtensionTools(registry, ['mcp']).map(tool => tool.name), ['lookup']);
  assert.deepEqual(delegatedExtensionTools(registry, ['mcp', 'feishu']).map(tool => tool.name), ['lookup']);
  assert.equal(capabilityProblem(registry, ['mcp', 'other']), null);
  assert.match(capabilityProblem(registry, ['missing'])!, /No active extension.*"missing"/);
  assert.match(capabilityProblem(registry, ['feishu'])!, /reserved for Mira/);
  const [tool] = delegatedExtensionTools(registry, ['other']) as AgentTool[];
  assert.deepEqual((await tool!.execute('c1', {})).content, [{ type: 'text', text: 'other_tool' }]);
  assert.throws(() => snapshotTool({ name: 'x', description: 'd', parameters: { type: 'object' }, mainOnly: 'yes' as never, execute: async () => ({ text: '' }) }), /mainOnly/);
});

test('a delegated call cannot create, replace or cancel schedules; reads and main calls still work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-delegated-schedules-'));
  try {
    const modulePath = path.join(root, 'manual.mjs');
    await writeFile(modulePath, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
      export const state = { contexts: [] };
      export default defineExtension({ name: 'manual', apply(ctx) { state.contexts.push(ctx); ctx.registerTool({ name: 'manual_mark', mainOnly: true, description: 'm', parameters: { type: 'object' }, execute: async () => ({ text: 'm' }) }); } });`);
    const state = (await import(pathToFileURL(modulePath).href) as { state: { contexts: ExtensionContext[] } }).state;
    const configurationFile = path.join(root, 'extensions.json');
    await writeFile(configurationFile, JSON.stringify({ entries: [{ id: 'manual', path: modulePath }] }));
    let created = 0;
    const schedules: NonNullable<ExtensionHostOptions['schedules']> = () => ({
      create: async () => { created++; return { status: 'missing', delivery: null }; }, replace: async () => ({ status: 'missing', delivery: null }),
      cancel: async () => ({ status: 'missing', delivery: null }), get: async () => null, list: async () => [] });
    const host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive: async () => 'inserted', schedules });
    try {
      await host.start();
      const api = state.contexts.at(-1)!.schedules;
      const input = { key: 'k', dueAt: '2026-11-01T00:00:00.000Z', event: { id: 'e', type: 't', occurredAt: '2026-10-31T00:00:00.000Z', payload: {} } };
      for (const action of [() => api.create(input), () => api.replace(1, input), () => api.cancel('k', 1)])
        await assert.rejects(runDelegated(action), /Schedules are main-only/);
      assert.deepEqual(await runDelegated(() => api.list()), []);
      assert.equal(created, 0);
      await api.create(input); assert.equal(created, 1, 'Mira herself still schedules');
      const tools = (await host.prepareCapabilities()).tools;
      assert.equal(tools.find(tool => tool.tool.name === 'manual_mark')?.tool.mainOnly, true, 'mainOnly survives registration');
    } finally { await host.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reported result payload leads with summary and question and omits the raw text; unreported keeps it', () => {
  const base: SubagentTurn = { id: 't', childId: 'c', callId: 'k', sequence: 1, instruction: 'i', status: 'completed', createdAt: 'x', startedAt: 'x', finishedAt: 'x',
    activity: { current: null, events: [], dropped: 0, updatedAt: null }, result: { text: 'FULL', truncated: false, fullResultPath: '/spool/t.txt', finalRecordId: null, report: { summary: 'S', question: 'Q?' } } };
  const reported = subagentCompletionPayload(base) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reported).slice(0, 3), ['summary', 'question', 'childId']);
  assert.ok(!JSON.stringify(reported).includes('FULL'));
  assert.deepEqual(reported['result'], { fullResultPath: '/spool/t.txt', finalRecordId: null });
  const unreported = subagentCompletionPayload({ ...base, result: { text: 'FULL', truncated: false, fullResultPath: null, finalRecordId: null } }) as Record<string, unknown>;
  assert.equal(unreported['summary'], undefined); assert.equal(unreported['awaiting'], undefined);
  assert.equal((unreported['result'] as { text: string }).text, 'FULL');
});
