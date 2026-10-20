import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { bashTimeouts, createWorkspaceTools, withBashTimeout } from '@mira/server';
import { boundPromptMemory, MEMORY_PROMPT_BYTES } from '@mira/workspace';

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? '').join('\n');

test('workspace bash advertises and applies a default timeout and cap', async () => {
  const bash = createWorkspaceTools(process.cwd()).find(tool => tool.name === 'bash')!;
  assert.deepEqual(bashTimeouts, { defaultSeconds: 120, maxSeconds: 600 });
  assert.match(bash.description, /time out after 120 seconds by default \(at most 600\)/);
  assert.match(bash.description, /exec_command/);
  const timeout = (bash.parameters as unknown as { properties: Record<string, { description: string }> }).properties['timeout']!;
  assert.match(timeout.description, /Default 120, maximum 600/);
  const ok = await bash.execute('bash-ok', { command: 'printf fine' } as never);
  assert.match(text(ok as never), /fine/);
});

test('bash timeout defaults, clamps and explains how to run long commands instead', async () => {
  const seen: unknown[] = [];
  const fake: AgentTool = { name: 'bash', label: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', description: 'old' } } } as never,
    execute: async (_id, args) => { seen.push((args as { timeout?: number }).timeout); return { content: [{ type: 'text', text: 'ok' }], details: {} }; } };
  const wrapped = withBashTimeout(fake);
  await wrapped.execute('a', { command: 'x' } as never);
  await wrapped.execute('b', { command: 'x', timeout: 5 } as never);
  await wrapped.execute('c', { command: 'x', timeout: 5_000 } as never);
  await wrapped.execute('d', { command: 'x', timeout: -1 } as never);
  assert.deepEqual(seen, [120, 5, 600, 120]);
  const read = { ...fake, name: 'read' }; assert.equal(withBashTimeout(read), read, 'other tools are unchanged');
});

test('a hung bash command times out with a hint to use the managed terminal', async () => {
  const bash = withBashTimeout(createWorkspaceTools(process.cwd()).find(tool => tool.name === 'bash')!, { defaultSeconds: 1, maxSeconds: 2 });
  const started = Date.now();
  await assert.rejects(bash.execute('hung', { command: 'sleep 30' } as never), (error: Error) => {
    assert.match(error.message, /Command timed out after 1 seconds/);
    assert.match(error.message, /use exec_command \(managed terminal\)/);
    return true;
  });
  assert.ok(Date.now() - started < 10_000);
});

test('MEMORY.md is bounded in the prompt with whole lines, a size note and the file path; small files are unchanged', () => {
  const small = '# Memory\n- likes tea\n';
  assert.equal(boundPromptMemory(small, '/m/MEMORY.md'), small);
  const line = '- 用户偏好：中文回复，简洁直接。 detail detail detail\n';
  const large = line.repeat(Math.ceil(MEMORY_PROMPT_BYTES * 2 / Buffer.byteLength(line))) + 'LAST_LINE_MARKER\n';
  const bounded = boundPromptMemory(large, '/m/MEMORY.md');
  assert.ok(Buffer.byteLength(bounded) <= MEMORY_PROMPT_BYTES, String(Buffer.byteLength(bounded)));
  assert.doesNotMatch(bounded, /LAST_LINE_MARKER/);
  assert.match(bounded, new RegExp(`MEMORY.md is ${Buffer.byteLength(large)} UTF-8 bytes`));
  assert.match(bounded, /"\/m\/MEMORY.md"/); assert.match(bounded, /read offset\/limit/);
  const body = bounded.slice(0, bounded.indexOf('\n\n[MEMORY.md'));
  assert.ok(body.endsWith('detail'), 'cut on a line boundary'); assert.ok(body.isWellFormed());
  assert.throws(() => boundPromptMemory(large, '/m/MEMORY.md', 10), /Invalid Memory prompt limit/);
});

test('the server prompt loader injects the bounded Memory text, never the full file', async () => {
  const { loadPromptMemory, setupMemoryWorkspace } = await import('@mira/workspace');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-memory-cap-'));
  try {
    const memoryRoot = path.join(root, 'memory');
    await setupMemoryWorkspace({ memoryRoot, sourceDirectory: process.cwd() });
    await writeFile(path.join(memoryRoot, 'MEMORY.md'), 'x'.repeat(MEMORY_PROMPT_BYTES * 3));
    const loaded = await loadPromptMemory({ memoryRoot });
    assert.ok(Buffer.byteLength(loaded) <= MEMORY_PROMPT_BYTES); assert.match(loaded, /MEMORY\.md is 147456 UTF-8 bytes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
