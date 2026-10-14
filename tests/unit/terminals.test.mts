import { assistant, input, MemoryWriter, runtime, streamOf } from '../recovery/fixtures.mts';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeWakeInput } from '@mira/workspace';
import { createTerminalTools, TerminalManager, terminalLimits, type TerminalResult } from '../../apps/server/src/terminals.ts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const owner = 'main-stream';
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;
async function fixture(run: (manager: TerminalManager, base: string, create: () => TerminalManager) => Promise<void>): Promise<void> {
  // Outside the test runner's synthetic HOME: the real spool adapter rejects home paths.
  const base = await realpath(await mkdtemp('/tmp/mira-terminals-test-'));
  const managers: TerminalManager[] = [];
  const create = () => {
    const manager = new TerminalManager({ cwd: base, writeOverflowInput: (runId, content) => writeWakeInput({ rootDirectory: path.join(base, 'spool'), sourceDirectory, runId, content }) });
    managers.push(manager); return manager;
  };
  try { await run(create(), base, create); }
  finally { await Promise.all(managers.map(manager => manager.close())); await rm(base, { recursive: true, force: true }); }
}
async function drain(manager: TerminalManager, first: TerminalResult, maxBytes = 8192, timeoutMs = 15_000): Promise<{ result: TerminalResult; output: string }> {
  let result = first, output = first.output;
  const until = Date.now() + timeoutMs;
  while (result.status === 'running' || result.has_more) {
    assert.ok(Date.now() < until, `Terminal did not finish: ${result.session_id}`);
    const previous = result.next_offset;
    result = await manager.write(owner, { session_id: result.session_id, offset: previous, yield_ms: 100, max_output_bytes: maxBytes });
    assert.equal(result.offset, previous);
    assert.equal(result.next_offset - result.offset, Buffer.byteLength(result.output));
    assert.ok(Buffer.byteLength(result.output) <= maxBytes);
    output += result.output;
  }
  return { result, output };
}
async function untilOutput(manager: TerminalManager, first: TerminalResult, marker: string): Promise<{ result: TerminalResult; output: string }> {
  let result = first, output = first.output;
  const until = Date.now() + 10_000;
  while (!output.includes(marker)) {
    assert.equal(result.status, 'running'); assert.ok(Date.now() < until, `Missing terminal marker ${marker}: ${output}`);
    result = await manager.write(owner, { session_id: result.session_id, offset: result.next_offset, yield_ms: 100 }); output += result.output;
  }
  return { result, output };
}
async function shell(manager: TerminalManager): Promise<TerminalResult> {
  const start = await manager.exec(owner, { command: 'exec /bin/bash --noprofile --norc -i', tty: true, yield_ms: 0 });
  // Disable echo so a command's source cannot satisfy its output assertions.
  const ready = await manager.write(owner, { session_id: start.session_id, offset: start.next_offset, chars: "stty -echo; export PS1=''; printf '\\nREADY-%s\\n' terminal\n", yield_ms: 0 });
  return (await untilOutput(manager, ready, 'READY-terminal')).result;
}

test('real pipe process yields, survives a later call, and exposes durable complete logs', async () => fixture(async manager => {
  const first = await manager.exec(owner, { command: "printf first; sleep 0.15; printf second; exit 7", yield_ms: 0 });
  assert.equal(first.status, 'running');
  const done = await drain(manager, first);
  assert.equal(done.output, 'firstsecond'); assert.equal(done.result.status, 'exited'); assert.equal(done.result.exit_code, 7);
  const reread = await manager.write(owner, { session_id: first.session_id, offset: 0, yield_ms: 0 });
  assert.equal(reread.output, 'firstsecond');
  const index = JSON.parse(await readFile(done.result.log_index!, 'utf8')) as { bytes: number; chunks: Array<{ path: string }> };
  assert.equal(index.bytes, 11); assert.equal((await Promise.all(index.chunks.map(chunk => readFile(chunk.path, 'utf8')))).join(''), 'firstsecond');
}));

test('real PTY shell retains cwd and environment while fresh execs are isolated', async () => fixture(async (manager, base) => {
  await mkdir(path.join(base, 'child'));
  let current = await shell(manager);
  current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: "cd child; export MIRA_TERMINAL_TEST_VALUE=retained; printf 'SET-%s\\n' ready\n", yield_ms: 0 });
  current = (await untilOutput(manager, current, 'SET-ready')).result;
  current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: "printf 'STATE:%s:%s\\n' \"$PWD\" \"$MIRA_TERMINAL_TEST_VALUE\"\n", yield_ms: 0 });
  const state = await untilOutput(manager, current, `STATE:${base}/child:retained`);
  assert.match(state.output, /retained/);
  const fresh = await drain(manager, await manager.exec(owner, { command: "printf '%s:%s' \"$PWD\" \"${MIRA_TERMINAL_TEST_VALUE-unset}\"", yield_ms: 0 }));
  assert.equal(fresh.output, `${base}:unset`);
}));

test('UTF-8 incremental byte offsets do not drop or duplicate across spool chunks', async () => fixture(async manager => {
  const expected = 'x'.repeat(16_383) + '😀汉é'.repeat(4000) + '\nEND';
  const first = await manager.exec(owner, { command: node(`process.stdout.write(${JSON.stringify(expected)})`), yield_ms: 0, max_output_bytes: 257 });
  const done = await drain(manager, first, 257);
  assert.equal(done.output, expected); assert.equal(done.result.next_offset, Buffer.byteLength(expected));
  const small = await manager.write(owner, { session_id: first.session_id, offset: 16_383, max_output_bytes: 4, yield_ms: 0 });
  assert.equal(small.output, '😀'); assert.equal(small.next_offset, 16_387);
  await assert.rejects(manager.write(owner, { session_id: first.session_id, offset: 16_384, yield_ms: 0 }), /UTF-8 character boundary/);
}));

test('same-session input is ordered and a waiting session does not block another', async () => fixture(async manager => {
  const first = await manager.exec(owner, { command: "while IFS= read -r line; do printf '<%s>' \"$line\"; [ \"$line\" = end ] && break; done", yield_ms: 0 });
  const writes = ['one\n', 'two\n', 'end\n'].map(chars => manager.write(owner, { session_id: first.session_id, offset: 0, chars, yield_ms: 0 }));
  await Promise.all(writes);
  const ordered = await drain(manager, await manager.write(owner, { session_id: first.session_id, offset: 0, yield_ms: 0 }));
  assert.equal(ordered.output, '<one><two><end>');
  const slow = await manager.exec(owner, { command: 'sleep 30', yield_ms: 0 });
  let slowSettled = false;
  const waiting = manager.write(owner, { session_id: slow.session_id, offset: 0, yield_ms: 1000 }).then(value => { slowSettled = true; return value; });
  const fast = await drain(manager, await manager.exec(owner, { command: 'printf independent', yield_ms: 0 }));
  assert.equal(fast.output, 'independent'); assert.equal(slowSettled, false);
  const closing = manager.closeSession(owner, slow.session_id);
  assert.equal((await waiting).status, 'running', 'close queues after the active read');
  assert.equal((await closing).status, 'closed');
}));

test('wrong stream cannot read, write, or close another stream session', async () => fixture(async manager => {
  const first = await manager.exec(owner, { command: "read -r line; printf 'secret:%s' \"$line\"", yield_ms: 0 });
  for (const result of [await manager.write('child-stream', { session_id: first.session_id, offset: 0, chars: 'wrong\n' }), await manager.closeSession('child-stream', first.session_id)]) {
    assert.equal(result.status, 'unavailable'); assert.equal(result.output, ''); assert.equal(result.log_index, undefined);
  }
  const done = await drain(manager, await manager.write(owner, { session_id: first.session_id, offset: 0, chars: 'right\n', yield_ms: 0 }));
  assert.equal(done.output, 'secret:right');
}));

test('PTY Ctrl-C interrupts a foreground job and leaves the shell usable', async () => fixture(async manager => {
  let current = await shell(manager);
  current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: "printf 'JOB-%s\\n' started; sleep 30\n", yield_ms: 0 });
  current = (await untilOutput(manager, current, 'JOB-started')).result;
  await delay(50);
  current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, interrupt: true, yield_ms: 100 });
  current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: "printf 'AFTER-%s\\n' interrupt\n", yield_ms: 0 });
  const after = await untilOutput(manager, current, 'AFTER-interrupt'); assert.equal(after.result.status, 'running');
}));

async function active(pid: number): Promise<boolean> {
  try { const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'stat=', '-p', String(pid)]); return !!stdout.trim() && !stdout.trim().startsWith('Z'); }
  catch { return false; }
}
test('explicit close terminates a real process and its observed child tree', async () => fixture(async manager => {
  const first = await manager.exec(owner, { command: "sleep 30 & child=$!; printf '%s %s\\n' \"$$\" \"$child\"; wait", yield_ms: 0 });
  const started = await untilOutput(manager, first, '\n');
  const pids = started.output.trim().split(/\s+/).map(Number); assert.equal(pids.length, 2);
  for (const pid of pids) assert.equal(await active(pid), true);
  const closed = await manager.closeSession(owner, first.session_id, started.result.next_offset); assert.equal(closed.status, 'closed');
  for (const pid of pids) assert.equal(await active(pid), false, `PID ${pid} still running after close`);
}));

test('aborting a wait leaves its process alive and its eventual output readable', async () => fixture(async manager => {
  const first = await manager.exec(owner, { command: 'sleep 0.3; printf survived', yield_ms: 0 });
  const abort = new AbortController();
  const waiting = manager.write(owner, { session_id: first.session_id, offset: 0, yield_ms: 10_000 }, abort.signal);
  await delay(30); abort.abort();
  const cancelled = await waiting; assert.match(cancelled.message!, /not terminated/); assert.equal(cancelled.status, 'running');
  const done = await drain(manager, cancelled); assert.equal(done.output, 'survived'); assert.equal(done.result.exit_code, 0);
}));

test('limits reject invalid calls and concurrent capacity frees only after close', async () => fixture(async manager => {
  for (const args of [{ command: '' }, { command: 'true', yield_ms: -1 }, { command: 'true', yield_ms: 10_001 }, { command: 'true', max_output_bytes: 3 }, { command: 'true', max_output_bytes: 8193 }, { command: 'x'.repeat(32_769) }]) {
    await assert.rejects(manager.exec(owner, args), /Invalid terminal/);
  }
  const running = await Promise.all(Array.from({ length: terminalLimits.concurrent }, () => manager.exec(owner, { command: 'sleep 30', yield_ms: 0 })));
  await assert.rejects(manager.exec(owner, { command: 'true', yield_ms: 0 }), /capacity/);
  const first = running[0]!;
  await assert.rejects(manager.write(owner, { session_id: first.session_id, offset: -1 }), /Invalid terminal/);
  await assert.rejects(manager.write(owner, { session_id: first.session_id, offset: 1 }), /beyond persisted output/);
  await assert.rejects(manager.write(owner, { session_id: first.session_id, offset: 0, chars: 'x'.repeat(32_769) }), /Invalid terminal/);
  await manager.closeSession(owner, first.session_id);
  const next = await drain(manager, await manager.exec(owner, { command: 'printf capacity-freed', yield_ms: 0 })); assert.equal(next.output, 'capacity-freed');
}));

test('new manager invalidates old handles without replaying side effects; tool results stay structured', async () => fixture(async (manager, base, create) => {
  const tools = createTerminalTools(manager, owner); assert.deepEqual(tools.map(tool => tool.name), ['terminal_list', 'exec_command', 'write_stdin', 'terminal_close']);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.find(tool => tool.name === name)!.execute('test-call', args, new AbortController().signal);
    const content = result.content[0]!; assert.equal(content.type, 'text');
    assert.ok('text' in content); return JSON.parse(content.text) as TerminalResult & { error?: string };
  };
  assert.match((await invoke('exec_command', { command: '', yield_ms: 0 })).error!, /Invalid terminal/);
  const first = await invoke('exec_command', { command: 'printf once >> effects; printf logged', yield_ms: 0 });
  const done = await drain(manager, first); assert.equal(done.output, 'logged');
  const ended = await invoke('write_stdin', { session_id: first.session_id, offset: done.result.next_offset, chars: 'bad' }); assert.match(ended.error!, /ended terminal/);
  const closed = await invoke('terminal_close', { session_id: first.session_id, offset: done.result.next_offset });
  assert.equal(closed.status, 'exited'); assert.equal(closed.output, '');
  await manager.close();
  const restarted = create();
  const old = await restarted.write(owner, { session_id: first.session_id, offset: 0 }); assert.equal(old.status, 'unavailable'); assert.match(old.message!, /Never automatically replay/);
  assert.equal(await readFile(path.join(base, 'effects'), 'utf8'), 'once');
  const index = JSON.parse(await readFile(done.result.log_index!, 'utf8')) as { chunks: Array<{ path: string }> };
  assert.equal((await Promise.all(index.chunks.map(chunk => readFile(chunk.path, 'utf8')))).join(''), 'logged');
  await assert.rejects(manager.exec(owner, { command: 'true' }), /manager is closed/);
}));


test('SIGKILL of the manager owner closes its supervisor and real process tree', async () => fixture(async (_manager, base) => {
  const moduleUrl = new URL('../../apps/server/src/terminals.ts', import.meta.url).href;
  const script = `
    import { TerminalManager } from ${JSON.stringify(moduleUrl)};
    import { writeWakeInput } from '@mira/workspace';
    const manager = new TerminalManager({ cwd: ${JSON.stringify(base)}, writeOverflowInput: (runId, content) => writeWakeInput({ rootDirectory: ${JSON.stringify(path.join(base, 'crash-spool'))}, sourceDirectory: ${JSON.stringify(sourceDirectory)}, runId, content }) });
    let result = await manager.exec('crash-owner', { command: 'sleep 30 & child=$!; printf "%s %s\\n" "$$" "$child"; wait', yield_ms: 1000 });
    let output = result.output;
    while (!output.includes('\\n')) { result = await manager.write('crash-owner', { session_id: result.session_id, offset: result.next_offset, yield_ms: 1000 }); output += result.output; }
    process.stdout.write(JSON.stringify({ pids: output.trim().split(/\\s+/).map(Number), session: result.session_id }) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: sourceDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  let pids: number[] = [];
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const reported = await new Promise<{ pids: number[]; session: string }>((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(Error(`Owner did not report ready: ${stderr}`)), 10_000);
      child.stderr.on('data', data => { stderr += String(data); });
      child.stdout.on('data', data => { stdout += String(data); if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error(`Owner exited before ready: ${stderr}`)); });
    });
    pids = reported.pids; assert.equal(pids.length, 2);
    for (const pid of pids) assert.equal(await active(pid), true);
    child.kill('SIGKILL'); await exited;
    const until = Date.now() + 5000;
    while ((await Promise.all(pids.map(active))).some(Boolean) && Date.now() < until) await delay(25);
    for (const pid of pids) assert.equal(await active(pid), false, `PID ${pid} survived manager-owner death`);
    const indexFiles = await _manager.write('crash-owner', { session_id: reported.session, offset: 0 });
    assert.equal(indexFiles.status, 'unavailable');
  } finally {
    child.kill('SIGKILL'); await exited;
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  }
}));


test('aborting exec after spawn returns the live handle rather than replaying or killing', async () => fixture(async manager => {
  const abort = new AbortController();
  const started = manager.exec(owner, { command: 'sleep 0.3; printf one-execution', yield_ms: 10_000 }, abort.signal);
  await delay(30); abort.abort();
  const yielded = await started; assert.equal(yielded.status, 'running'); assert.match(yielded.message!, /not terminated/);
  assert.match(yielded.session_id, /^[0-9a-f-]{36}$/);
  const done = await drain(manager, yielded); assert.equal(done.output, 'one-execution'); assert.equal(done.result.exit_code, 0);
}));

test('invalid UTF-8 offset is rejected before sending stdin', async () => fixture(async manager => {
  const first = await manager.exec(owner, { command: "printf '汉'; read value; printf 'VALUE:%s' \"$value\"", yield_ms: 1000 });
  assert.equal(first.output, '汉');
  await assert.rejects(manager.write(owner, { session_id: first.session_id, offset: 1, chars: 'wrong\n', yield_ms: 0 }), /UTF-8 character boundary/);
  const next = await manager.write(owner, { session_id: first.session_id, offset: first.next_offset, chars: 'right\n', yield_ms: 0 });
  const done = await drain(manager, next);
  assert.equal(done.output, 'VALUE:right');
}));

test('slow durable storage cannot silently lose a fast PTY final tail', async () => fixture(async (_manager, base) => {
  const manager = new TerminalManager({ cwd: base, writeOverflowInput: async (runId, content) => {
    if (runId.startsWith('terminal:')) await delay(400);
    return writeWakeInput({ rootDirectory: path.join(base, 'slow-spool'), sourceDirectory, runId, content });
  } });
  try {
    const expected = 'x'.repeat(40_000);
    const done = await drain(manager, await manager.exec(owner, { command: node(`process.stdout.write('x'.repeat(40000))`), tty: true, yield_ms: 0 }), 8192, 45_000);
    assert.equal(done.output, expected); assert.equal(done.result.status, 'exited'); assert.equal(done.result.exit_code, 0);
  } finally { await manager.close(); }
}));

test('pipe input acknowledgement stays bounded when the command never reads stdin', async () => fixture(async manager => {
  let current = await manager.exec(owner, { command: 'sleep 30', yield_ms: 0 });
  for (let index = 0; index < 5; index++) {
    const writing = manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: 'x'.repeat(32_768), yield_ms: 0 });
    void writing.catch(() => {});
    current = await Promise.race([writing, delay(1500).then(() => { throw Error('Input acknowledgement exceeded its bound'); })]);
  }
  const interrupted = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, interrupt: true, yield_ms: 0 });
  await drain(manager, interrupted);
}));

test('natural PTY exit exposes the limited cleanup scope for regrouped background jobs', async () => fixture(async manager => {
  const done = await drain(manager, await manager.exec(owner, { tty: true, command: "exec /bin/bash --noprofile --norc -ic 'sleep 30 & echo BG:$!; exit'", yield_ms: 0 }));
  const pid = Number(/BG:(\d+)/.exec(done.output)?.[1]); assert.ok(pid > 1);
  try {
    assert.match(done.result.cleanup_scope!, /Regrouped and reparented jobs may survive/);
    // Ordinary job control can reparent a different PGID before cleanup observes it.
    // The shared Mac/Linux contract deliberately does not claim this PID was killed.
    assert.equal(done.result.status, 'exited');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
}));

test('invalid close offset is rejected without terminating the process', async () => fixture(async manager => {
  const current = await manager.exec(owner, { command: "printf '😀'; sleep 30", yield_ms: 1000 });
  await assert.rejects(manager.closeSession(owner, current.session_id, 1), /UTF-8/);
  const alive = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, yield_ms: 0 });
  assert.equal(alive.status, 'running');
  await assert.rejects(manager.closeSession(owner, current.session_id, 9999), /Offset/);
}));

test('output preserves BOM code points and exact byte offsets on every page', async () => fixture(async manager => {
  const expected = '\ufeffhello\ufeffworld';
  const done = await drain(manager, await manager.exec(owner, { command: node(`process.stdout.write(${JSON.stringify(expected)})`), yield_ms: 0, max_output_bytes: 8 }), 8);
  assert.equal(done.output, expected); assert.equal(done.result.next_offset, Buffer.byteLength(expected));
}));

test('cancelled durable launch remains discoverable by owner and original call ID without replay', async () => fixture(async (manager, base) => {
  const writer = new MemoryWriter(); const entered = path.join(base, 'entered'); const abort = new AbortController();
  const tools = createTerminalTools(manager, writer.miraId);
  const instance = runtime(writer, () => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'cancelled-launch', name: 'exec_command',
    arguments: { command: `printf once >> ${quote(entered)}; exec sleep 30`, yield_ms: 10_000 } }] }), { tools });
  const work = instance.run(input(), abort.signal); void work.catch(() => {});
  const deadline = Date.now() + 5000;
  while (!await readFile(entered, 'utf8').then(() => true, () => false)) { assert.ok(Date.now() < deadline); await delay(10); }
  abort.abort(Error('synthetic cancellation')); await assert.rejects(work);
  assert.equal(writer.state.executions[0]!.outcome, null);
  const list = tools.find(tool => tool.name === 'terminal_list')!;
  const result = await list.execute('discover', {}, undefined);
  const sessions = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('')) as Array<{ session_id: string; launch_call_id: string }>;
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.launch_call_id, 'cancelled-launch');
  assert.deepEqual(manager.list('another-child'), []);
  const closing = tools.find(tool => tool.name === 'terminal_close')!;
  await closing.execute('close-discovered', { session_id: sessions[0]!.session_id, offset: 0 }, undefined);
  assert.equal(await readFile(entered, 'utf8'), 'once');
}));

test('stdin byte and lifetime budgets reject before queuing extra input', async () => fixture(async manager => {
  let current = await manager.exec(owner, { command: 'sleep 30', yield_ms: 0 });
  await assert.rejects(manager.write(owner, { session_id: current.session_id, offset: 0, chars: '汉'.repeat(32_768), yield_ms: 0 }), /Invalid terminal/);
  for (let index = 0; index < 32; index++) current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: 'x'.repeat(32_768), yield_ms: 0 });
  assert.equal(current.input_bytes_remaining, 0);
  await assert.rejects(manager.write(owner, { session_id: current.session_id, offset: current.next_offset, chars: 'extra', yield_ms: 0 }), /not accepted/);
  // Control remains available even when the text input budget is exhausted.
  await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, interrupt: true, yield_ms: 0 });
}));

test('PTY pending output overflow is explicit rather than silent truncation', async () => fixture(async (_manager, base) => {
  const manager = new TerminalManager({ cwd: base, writeOverflowInput: async (runId, content) => {
    if (runId.startsWith('terminal:')) await delay(5);
    return writeWakeInput({ rootDirectory: path.join(base, 'bounded-spool'), sourceDirectory, runId, content });
  } });
  try {
    const result = await manager.exec(owner, { command: node("process.stdout.write('x'.repeat(4*1024*1024))"), tty: true, yield_ms: 0 });
    let current = result;
    const deadline = Date.now() + 30_000;
    while (current.status === 'running') { assert.ok(Date.now() < deadline); current = await manager.write(owner, { session_id: current.session_id, offset: current.next_offset, yield_ms: 100 }); }
    assert.equal(current.status, 'output_limit'); assert.match(current.message!, /Excess output was not retained/);
  } finally { await manager.close(); }
}));

test('failed durable output and total log limit both release a paused pipe on shutdown', async () => fixture(async (_manager, base) => {
  for (const mode of ['storage_failure', 'log_limit'] as const) {
    const original = terminalLimits.logBytes;
    if (mode === 'log_limit') (terminalLimits as { logBytes: number }).logBytes = 1024;
    const manager = new TerminalManager({ cwd: base, writeOverflowInput: async (runId, content) => {
      if (mode === 'storage_failure' && runId.startsWith('terminal:')) throw Error('synthetic disk full');
      return writeWakeInput({ rootDirectory: path.join(base, mode), sourceDirectory, runId, content });
    } });
    try {
      const work = manager.exec(owner, { command: node('process.stdout.write("x".repeat(1024*1024)); setTimeout(()=>{},30000)'), yield_ms: 1000 });
      if (mode === 'storage_failure') await assert.rejects(work, /synthetic disk full/);
      else assert.equal((await work).status, 'output_limit');
      await Promise.race([manager.close(), delay(3500).then(() => { throw Error(`${mode} stalled shutdown`); })]);
    } finally { (terminalLimits as { logBytes: number }).logBytes = original; await manager.close(); }
  }
}));

test('cancelled or expired reads snapshot persisted output without waiting for a slow log backlog', async () => fixture(async (_manager, base) => {
  let saving = false;
  const manager = new TerminalManager({ cwd: base, writeOverflowInput: async (runId, content) => {
    if (runId.startsWith('terminal:')) { saving = true; await delay(2500); }
    return writeWakeInput({ rootDirectory: path.join(base, 'yield-spool'), sourceDirectory, runId, content });
  } });
  try {
    const initial = await manager.exec(owner, { command: "printf result; sleep 30", yield_ms: 0 });
    while (!saving) await delay(10);
    const expiredAt = Date.now();
    const expired = await manager.write(owner, { session_id: initial.session_id, offset: 0, yield_ms: 0 });
    assert.ok(Date.now() - expiredAt < 1000); assert.equal(expired.output, ''); assert.equal(expired.output_pending, true); assert.equal(expired.has_more, true);
    const abort = new AbortController(); const before = Date.now();
    const waiting = manager.write(owner, { session_id: initial.session_id, offset: 0, yield_ms: 10_000 }, abort.signal);
    await delay(50); abort.abort(); const cancelled = await waiting;
    assert.ok(Date.now() - before < 1000); assert.equal(cancelled.output_pending, true); assert.match(cancelled.message!, /not terminated/);
    const later = await manager.write(owner, { session_id: initial.session_id, offset: 0, yield_ms: 5000 });
    assert.equal(later.output, 'result');
  } finally { await manager.close(); }
}));
