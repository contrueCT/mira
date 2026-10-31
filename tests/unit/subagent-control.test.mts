import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { writeWakeInput } from '@mira/workspace';
import { withFileToolLimits } from '../../apps/server/src/file-tool-limits.ts';
import { createWorkspaceTools } from '../../apps/server/src/index.ts';
import { BrowserManager } from '../../apps/server/src/browser-manager.ts';
import type { BrowserDriver } from '../../apps/server/src/browser-driver.ts';
import { TerminalManager } from '../../apps/server/src/terminals.ts';

// ADR 0051: child file-tool bounds and strictly owner-scoped cancel cleanup.
const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = (value: Awaited<ReturnType<AgentTool['execute']>>) => value.content.map(block => block.type === 'text' ? block.text : '').join('');

test('a child file tool with no result after its bound is aborted and reports an unknown outcome', async () => {
  let aborted = false;
  const hanging = (name: string): AgentTool => ({ name, label: name, description: name, parameters: Type.Object({}),
    execute: (_id, _args, signal) => new Promise(() => { signal?.addEventListener('abort', () => { aborted = true; }); }) });
  const [write] = withFileToolLimits([hanging('write')], '/tmp', 30);
  const outcome = await write!.execute('w', { path: '/tmp/never' }, undefined);
  assert.equal(outcome.isError, true); assert.equal(aborted, true);
  const body = JSON.parse(text(outcome));
  assert.equal(body.status, 'unknown'); assert.equal(body.tool, 'write'); assert.match(body.note, /Whether the file changed is unknown/);
  aborted = false;
  const [grep] = withFileToolLimits([hanging('grep')], '/tmp', 30);
  const read = JSON.parse(text(await grep!.execute('g', { pattern: 'x' }, undefined)));
  assert.match(read.note, /This tool changes nothing/); assert.equal(aborted, true);
  // bash and other tools are untouched.
  const bash = hanging('bash'); assert.equal(withFileToolLimits([bash], '/tmp', 30)[0], bash);
});

test('a parent abort still reaches the wrapped file tool', async () => {
  let aborted = false; const controller = new AbortController();
  const [read] = withFileToolLimits([{ name: 'read', label: 'read', description: 'read', parameters: Type.Object({}),
    execute: (_id, _args, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }); }) }], '/tmp', 60_000);
  const pending = read!.execute('r', { path: '/etc/hostname' }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort();
  await assert.rejects(pending, /aborted/); assert.equal(aborted, true);
});

test('real Pi read/write refuse a FIFO and a device before touching it; regular files still work', async () => {
  const base = await realpath(await mkdtemp('/tmp/mira-file-limits-'));
  try {
    execFileSync('mkfifo', [path.join(base, 'pipe')]);
    await writeFile(path.join(base, 'plain.txt'), 'hello');
    const tools = withFileToolLimits(createWorkspaceTools(base), base, 5_000);
    const read = tools.find(tool => tool.name === 'read')!; const write = tools.find(tool => tool.name === 'write')!;
    const started = Date.now();
    const fifo = await read.execute('r1', { path: 'pipe' }, undefined);
    assert.equal(fifo.isError, true); assert.match(text(fifo), /is a FIFO/); assert.ok(Date.now() - started < 2_000);
    assert.match(text(await write.execute('w1', { path: 'pipe', content: 'x' }, undefined)), /is a FIFO/);
    assert.match(text(await read.execute('r2', { path: '/dev/zero' }, undefined)), /is a device/);
    assert.match(text(await read.execute('r3', { path: 'plain.txt' }, undefined)), /hello/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

class FakeDriver implements BrowserDriver {
  closed: string[] = [];
  async open() { return {}; }
  async command() { return { snapshot: 'page' }; }
  async humanInput() {}
  async stream() { return 'ws://127.0.0.1:1'; }
  async pauseStream() {}
  async resumeStream() {}
  async close(session: string) { this.closed.push(session); }
  async dispose() {}
}

test('browser closeOwner closes only the named child stream; main and sibling browsers and a user-held child browser stay open', async () => {
  const driver = new FakeDriver(); const manager = new BrowserManager({ driver, mainOwner: 'main-life' });
  try {
    const main = await manager.bind('main-life').open('https://example.com/main');
    const child = manager.bind('subagent:child-a'); const sibling = await manager.bind('subagent:child-b').open('https://example.com/b');
    const first = await child.open('https://example.com/a1'); const held = await child.open('https://example.com/a2');
    await manager.takeover(held.id);
    assert.deepEqual(await manager.closeOwner('subagent:child-a'), { closed: 1, kept: 1 });
    const state = new Map(manager.list().map(status => [status.id, status.state]));
    assert.equal(state.get(first.id), 'closed'); assert.equal(state.get(held.id), 'human');
    assert.equal(state.get(main.id), 'agent'); assert.equal(state.get(sibling.id), 'agent');
    assert.equal(driver.closed.length, 1);
    // The main owner, an empty owner and a prefix never match.
    assert.deepEqual(await manager.closeOwner('main-life'), { closed: 0, kept: 0 });
    assert.deepEqual(await manager.closeOwner(''), { closed: 0, kept: 0 });
    assert.deepEqual(await manager.closeOwner('subagent:child'), { closed: 0, kept: 0 });
    assert.equal(manager.list().find(status => status.id === main.id)?.state, 'agent');
  } finally { await manager.close(); }
});

test('terminal closeOwner stops only the named child stream’s real processes; the main terminal keeps running', async () => {
  const base = await realpath(await mkdtemp('/tmp/mira-terminal-owner-'));
  const outputs: string[] = [];
  const manager = new TerminalManager({ cwd: base, onOutput: owner => outputs.push(owner), writeOverflowInput: (runId, content) => writeWakeInput({ rootDirectory: path.join(base, 'spool'), sourceDirectory, runId, content }) });
  try {
    const main = await manager.exec('main-life', { command: 'echo main-up; sleep 30', yield_ms: 200 });
    const child = await manager.exec('subagent:child-a', { command: 'echo child-up; sleep 30', yield_ms: 200 });
    const sibling = await manager.exec('subagent:child-b', { command: 'sleep 30', yield_ms: 0 });
    assert.equal(main.status, 'running'); assert.equal(child.status, 'running');
    assert.ok(outputs.includes('main-life') && outputs.includes('subagent:child-a'), 'output is attributed to its own owner');
    assert.equal(await manager.closeOwner('subagent:child'), 0, 'no prefix match');
    assert.equal(await manager.closeOwner('subagent:child-a'), 1);
    const status = (owner: string) => manager.list(owner).map(session => session.status);
    assert.deepEqual(status('subagent:child-a'), ['closed']);
    assert.deepEqual(status('main-life'), ['running']); assert.deepEqual(status('subagent:child-b'), ['running']);
    const again = await manager.write('main-life', { session_id: main.session_id, offset: main.next_offset, yield_ms: 50 });
    assert.equal(again.status, 'running');
    assert.ok(sibling.session_id);
  } finally { await manager.close(); await rm(base, { recursive: true, force: true }); }
});
