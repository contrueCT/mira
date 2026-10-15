import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { BrowserProcesses } from '../../apps/server/src/browser-processes.ts';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserManager, BrowserControlError } from '../../apps/server/src/browser-manager.ts';
import { AgentBrowserDriver, browserProtocolCommand, browserHumanInput, type BrowserDriver } from '../../apps/server/src/browser-driver.ts';

class FakeDriver implements BrowserDriver {
  calls: string[] = [];
  exitListener: ((session: string) => void) | undefined;
  onExit(listener: (session: string) => void) { this.exitListener = listener; return () => { this.exitListener = undefined; }; }
  gate: Promise<void> | undefined;
  fail = false;
  async open(session: string, url: string) { this.calls.push(`open:${session}:${url}`); return {}; }
  async command(_session: string, args: readonly string[]) { this.calls.push(args.join(' ')); await this.gate; if (this.fail) throw Error('secret upstream failure'); return { snapshot: 'page' }; }
  async humanInput(_session: string, input: Record<string, unknown>) { this.calls.push(String(input.action)); await this.gate; if (this.fail) throw Error('unknown input'); }
  async stream() { return 'ws://127.0.0.1:12345'; }
  async pauseStream() { this.calls.push('pause'); if (this.fail) throw Error('unknown'); }
  async resumeStream() { this.calls.push('resume'); }
  async close() { this.calls.push('close'); if (this.fail) throw Error('Cleanup could not be verified'); }
  async dispose() {}
}
async function setup() { const driver = new FakeDriver(); const manager = new BrowserManager({ driver }); const owner = manager.bind('main'); const browser = await owner.open('https://example.com'); return { driver, manager, owner, browser }; }

test('browser handles isolate owners and generations, and require fresh observations', async () => {
  const { driver, manager, owner, browser } = await setup();
  assert.equal(manager.bind('child').list().length, 0);
  await assert.rejects(manager.bind('child').command(browser.id, ['snapshot']), /belongs/);
  await assert.rejects(owner.command(browser.id, ['click', '@e1']), /Fresh/);
  const snapshot = await owner.command(browser.id, ['snapshot', '-i']);
  await owner.command(browser.id, ['click', '@e1'], snapshot.observation);
  await assert.rejects(owner.command(browser.id, ['click', '@e1'], snapshot.observation), /Fresh/);
  assert.notEqual(driver.calls[0]!.split(':')[1], browser.id);
  await assert.rejects(new BrowserManager({ driver }).bind('main').command(browser.id, ['snapshot']), /restart/);
  await manager.close();
});

test('takeover gates new and queued commands synchronously, waits for in-flight command', async () => {
  const { driver, manager, owner, browser } = await setup();
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const first = owner.command(browser.id, ['snapshot']);
  await Promise.resolve(); await Promise.resolve();
  const queued = owner.command(browser.id, ['snapshot']);
  const rejected = assert.rejects(queued, /control changed/);
  const takeover = manager.takeover(browser.id);
  assert.equal(manager.list()[0]!.state, 'requesting');
  await assert.rejects(owner.command(browser.id, ['snapshot']), /not under agent/);
  unblock(); await first; await rejected; const lease = await takeover;
  assert.equal(lease.state, 'human'); assert.deepEqual(driver.calls.slice(-2), ['pause', 'resume']); assert.equal(driver.calls.filter(c => c === 'snapshot').length, 1);
  await manager.close();
});

test('disconnect holds control, revokes epoch, explicit return drains before fresh observation', async () => {
  const { driver, manager, owner, browser } = await setup();
  const original = await owner.command(browser.id, ['snapshot']);
  const lease = await manager.takeover(browser.id);
  manager.disconnect(browser.id, lease.epoch);
  assert.equal(manager.list()[0]!.state, 'held'); assert.equal(manager.isHuman(browser.id, lease.epoch), false);
  await assert.rejects(manager.release(browser.id, lease.epoch), /Stale/);
  const newLease = await manager.takeover(browser.id);
  const returning = manager.release(browser.id, newLease.epoch);
  assert.equal(manager.isHuman(browser.id, newLease.epoch), false);
  assert.equal(manager.list()[0]!.state, 'returning');
  await returning;
  assert.deepEqual(driver.calls.slice(-3), ['pause', 'snapshot -i', 'resume']);
  await assert.rejects(owner.command(browser.id, ['click', '@e1'], original.observation), /Fresh/);
  const observed = await owner.command(browser.id, ['snapshot']);
  await owner.command(browser.id, ['click', '@e1'], observed.observation);
  await manager.close();
});

test('unknown command and return outcomes remain gated and are never replayed', async () => {
  const { driver, manager, owner, browser } = await setup(); driver.fail = true;
  await assert.rejects(owner.command(browser.id, ['snapshot']), /unknown/);
  assert.equal(manager.list()[0]!.state, 'unknown');
  await assert.rejects(owner.command(browser.id, ['snapshot']), /not under agent/);
  assert.equal(driver.calls.filter(c => c === 'snapshot').length, 1);
  driver.fail = false;
  const second = await owner.open('https://example.org'); const lease = await manager.takeover(second.id);
  driver.fail = true;
  await assert.rejects(manager.release(second.id, lease.epoch), /could not be verified/);
  assert.equal(manager.list()[1]!.state, 'unknown');
  await manager.close();
});

test('command mapping rejects control/engine/session/remote injection and preserves literal text', () => {
  for (const args of [['--session', 'other'], ['stream', 'enable'], ['connect', 'ws://other'], ['open', 'file:///tmp/test'], ['open', 'https://user:password@example.com'], ['snapshot', '--config', 'evil'], ['eval', '1'], ['click', '--cdp']]) assert.throws(() => browserProtocolCommand(args));
  assert.deepEqual(browserProtocolCommand(['fill', '@e1', '--session other; $(touch /tmp/no)']), { action: 'fill', selector: '@e1', value: '--session other; $(touch /tmp/no)' });
  assert.deepEqual(browserProtocolCommand(['get', 'url']), { action: 'url' });
});

test('real spawn checks pinned version without shell interpretation or launching another command', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'mira-browser-spawn-'));
  try {
    const executable = path.join(base, 'fake-browser'); const log = path.join(base, 'calls.json'); const environment = path.join(base, 'environment.json');
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); require('node:fs').writeFileSync(${JSON.stringify(environment)}, JSON.stringify(process.env)); console.log('agent-browser 9.9.9');\n`); await chmod(executable, 0o700);
    const previous = process.env['MIRA_BROWSER_SECRET_SENTINEL']; process.env['MIRA_BROWSER_SECRET_SENTINEL'] = 'must-not-inherit';
    const driver = new AgentBrowserDriver({ executable, cwd: base });
    if (previous === undefined) delete process.env['MIRA_BROWSER_SECRET_SENTINEL']; else process.env['MIRA_BROWSER_SECRET_SENTINEL'] = previous;
    await assert.rejects(driver.open('00000000-0000-0000-0000-000000000000', 'https://example.com/?q=$(touch%20no)'), /pinned/);
    assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), ['--version']);
    assert.equal(JSON.parse(await readFile(environment, 'utf8'))['MIRA_BROWSER_SECRET_SENTINEL'], undefined);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('real supervised daemon transport launches once, preserves generation, and never respawns after death', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'mira-browser-daemon-test-'));
  const executable = path.join(base, 'fake-native'); const log = path.join(base, 'commands.jsonl'); const failure = path.join(base, 'failure'); const descendant = path.join(base, 'descendant'); const relaunch = path.join(base, 'relaunch');
  const session = '11111111-1111-1111-1111-111111111111';
  const script = `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('agent-browser 0.39.1'); process.exit(0); }
const dir = process.env.AGENT_BROWSER_SOCKET_DIR, session = process.env.AGENT_BROWSER_SESSION;
fs.writeFileSync(path.join(dir, session + '.pid'), String(process.pid));
const server = net.createServer(socket => { let text = ''; socket.on('data', chunk => { text += chunk; if (!text.includes('\\n')) return; const cmd = JSON.parse(text.split('\\n')[0]); if (cmd.action === 'launch' || (cmd.action === 'snapshot' && fs.existsSync(${JSON.stringify(relaunch)}))) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true, stdio:'ignore'}); fs.appendFileSync(${JSON.stringify(descendant)}, String(child.pid) + '\\n'); } fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ action: cmd.action, pid: process.pid, directory: dir, engine: process.env.AGENT_BROWSER_ENGINE, requestedEngine: cmd.engine }) + '\\n'); socket.end(JSON.stringify({ id: cmd.id, success: true, data: { ...(cmd.action === 'stream_status' ? {enabled: true, port: 12345} : {ok: true}), lifecycle: { launched: cmd.action === 'launch', relaunchedBrowser: fs.existsSync(${JSON.stringify(relaunch)}) && cmd.action === 'snapshot', restartedBackground: false } } }) + '\\n'); if (cmd.action === 'close') server.close(() => process.exit(0)); }); });
server.on('error', e => { fs.writeFileSync(${JSON.stringify(failure)}, e.code || 'unknown'); process.exit(1); });
server.listen(path.join(dir, session + '.sock'));
`;
  const driver = new AgentBrowserDriver({ executable, cwd: base });
  try {
    await writeFile(executable, script); await chmod(executable, 0o700);
    try { await driver.open(session, 'https://example.com'); }
    catch (error) { if (!process.env['CI'] && await readFile(failure, 'utf8').catch(() => '') === 'EPERM') { t.skip('Host prohibits Unix sockets; real daemon transport gate is blocked'); return; } throw error; }
    await driver.command(session, ['snapshot']);
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.action), ['launch', 'navigate', 'snapshot']);
    assert.equal(lines[0].requestedEngine, 'chrome');
    await writeFile(relaunch, '1');
    await assert.rejects(driver.command(session, ['snapshot']), /instance changed/);
    await assert.rejects(driver.command(session, ['snapshot']), /invalidated/);
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 4);
    process.kill(lines[0].pid, 'SIGKILL');
    const childPids = (await readFile(descendant, 'utf8')).trim().split('\n').map(Number);
    assert.equal(childPids.length, 2, 'Expected initial and replacement detached browsers');
    for (const childPid of childPids) if (process.platform === 'linux') {
      const deadline = Date.now() + 3000;
      while (true) { const stat = await readFile(`/proc/${childPid}/stat`, 'utf8').catch(() => ''); if (!stat || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') break; assert.ok(Date.now() < deadline, 'Detached browser survived daemon crash'); await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    await assert.rejects(driver.command(session, ['snapshot']), /ended|transport|generation|ENOENT|invalidated/);
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 4);
  } finally { await driver.dispose(); const childPids = (await readFile(descendant, 'utf8').catch(() => '')).trim().split('\n').map(Number); for (const childPid of childPids) if (childPid > 1) { try { process.kill(-childPid, 'SIGKILL'); } catch {} } await rm(base, { recursive: true, force: true }); }
});


test('human control rejects agent close and daemon exit immediately revokes human input', async () => {
  const { driver, manager, owner, browser } = await setup();
  const lease = await manager.takeover(browser.id);
  await assert.rejects(owner.close(browser.id), BrowserControlError);
  await assert.rejects(owner.command(browser.id, ['snapshot', '--session', 'another']), BrowserControlError);
  const session = driver.calls[0]!.slice('open:'.length).split(':')[0]!;
  driver.exitListener?.(session);
  assert.equal(manager.list()[0]!.state, 'unknown');
  assert.equal(manager.isHuman(browser.id, lease.epoch), false);
  assert.equal(driver.calls.filter(c => c === 'close').length, 0);
  await manager.close();
});


test('owned descendant identities clean a detached browser group after daemon SIGKILL', async () => {
  const parent = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => parent.once('exit', () => resolve()));
  const owned = new BrowserProcesses(parent.pid!);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let childPid = 0;
  try {
    childPid = await new Promise<number>((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Missing descendant PID')), 3000); parent.stdout.once('data', data => { clearTimeout(timeout); resolve(Number(String(data).trim())); }); });
    assert.ok(childPid > 1); await owned.capture();
    process.kill(parent.pid!, 'SIGKILL'); await exited; owned.retireRoot();
    await owned.cleanup();
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(childPid, 0); if (process.platform === 'linux') { const stat = await readFile(`/proc/${childPid}/stat`, 'utf8'); alive = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; } }
      catch { alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'Captured detached browser descendant survived cleanup');
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0), 'Cleanup touched an unrelated process');
  } finally { unrelated.kill('SIGKILL'); try { parent.kill('SIGKILL'); } catch {} if (childPid) { try { process.kill(-childPid, 'SIGKILL'); } catch {} } await exited; }
});


test('cleanup failure remains unknown with both control paths gated until explicit close succeeds', async () => {
  const { driver, manager, owner, browser } = await setup(); driver.fail = true;
  await assert.rejects(owner.close(browser.id), /Cleanup/);
  assert.equal(manager.list()[0]!.state, 'unknown');
  assert.match(manager.list()[0]!.message!, /cleanup could not be verified/);
  await assert.rejects(owner.command(browser.id, ['snapshot']), BrowserControlError);
  await assert.rejects(manager.takeover(browser.id), BrowserControlError);
  driver.fail = false; await owner.close(browser.id);
  assert.equal(manager.list()[0]!.state, 'closed'); await manager.close();
});

test('ready ownership capture rejects a daemon with no live browser descendant', async () => {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const owned = new BrowserProcesses(daemon.pid!);
  try { await assert.rejects(owned.capture(true), /identity could not be captured/); }
  finally { await assert.rejects(owned.cleanup(), /cleanup unknown/); }
});


test('human input return cancels queued text while awaiting the issued input before snapshot', async () => {
  const { driver, manager, owner, browser } = await setup(); const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const first = manager.humanInput(browser.id, lease.epoch, { action: 'inserttext', text: 'private human text' });
  const second = manager.humanInput(browser.id, lease.epoch, { action: 'inserttext', text: 'last queued text' });
  const cancelled = second;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(manager.list()[0]!.queuedInputs, 1);
  const returning = manager.release(browser.id, lease.epoch);
  await assert.rejects(manager.humanInput(browser.id, lease.epoch, { action: 'press', key: 'Enter' }), BrowserControlError);
  assert.equal(driver.calls.includes('press'), false); assert.equal(driver.calls.includes('snapshot -i'), false);
  unblock(); await first; await cancelled; const returned = await returning;
  assert.equal(returned.cancelledInputs, 1); assert.equal(manager.list()[0]!.cancelledInputs, 1);
  assert.deepEqual(driver.calls.slice(-4), ['inserttext', 'pause', 'snapshot -i', 'resume']);
  assert.equal(JSON.stringify(manager.list()).includes('private human text'), false);
  await owner.close(browser.id); await manager.close();
});

test('stale-document queued human input is never sent and unknown in-flight input blocks return', async () => {
  const { driver, manager, browser } = await setup(); const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const first = manager.humanInput(browser.id, lease.epoch, { action: 'press', key: 'Tab' });
  const stale = manager.humanInput(browser.id, lease.epoch, { action: 'press', key: 'Enter' }, () => false);
  const staleRejected = stale;
  await Promise.resolve(); await Promise.resolve(); driver.fail = true;
  const failed = assert.rejects(first, /unknown/);
  const returning = assert.rejects(manager.release(browser.id, lease.epoch), /could not be verified/);
  unblock(); await failed; await staleRejected; await returning;
  assert.equal(driver.calls.filter(c => c === 'press').length, 1); assert.equal(driver.calls.includes('snapshot -i'), false);
  assert.equal(manager.list()[0]!.state, 'unknown'); driver.fail = false; await manager.close();
});

test('human input adapter accepts only bounded typed native fields', () => {
  assert.deepEqual(browserHumanInput({ action: 'input_mouse', type: 'mousePressed', x: 12, y: 13, button: 'left', clickCount: 1 }), { action: 'input_mouse', type: 'mousePressed', x: 12, y: 13, button: 'left', clickCount: 1 });
  for (const input of [{ action: 'eval', script: '1' }, { action: 'inserttext', text: 'text', session: 'other' }, { action: 'input_mouse', eventType: 'mousePressed' }, { action: 'input_mouse', type: 'mouseMoved', x: Infinity }, { action: 'press', key: 'a'.repeat(129) }]) assert.throws(() => browserHumanInput(input));
});

test('human input queue is bounded and revoked connection callbacks cancel unsent input', async () => {
  const { driver, manager, browser } = await setup(); const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  let connected = true;
  const first = manager.humanInput(browser.id, lease.epoch, { action: 'press', key: 'Tab' });
  const second = manager.humanInput(browser.id, lease.epoch, { action: 'press', key: 'Enter' }, () => connected);
  const cancelled = second;
  await Promise.resolve(); await Promise.resolve(); connected = false;
  const returning = manager.release(browser.id, lease.epoch); unblock(); await first; await cancelled; await returning;
  assert.equal(driver.calls.filter(c => c === 'press').length, 1);
  const next = await manager.takeover(browser.id);
  const pending = Array.from({ length: 129 }, () => manager.humanInput(browser.id, next.epoch, { action: 'press', key: 'Tab' }).then(() => null, error => error));
  const results = await Promise.all(pending);
  assert.ok(results.some(error => error?.message.includes('queue exceeded'))); assert.equal(manager.list()[0]!.state, 'unknown');
  await manager.close();
});


test('human input return awaits issued mouse click and cancels queued click without replay', async () => {
  const { driver, manager, browser } = await setup(); const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const click = { action: 'input_mouse', type: 'mouseReleased', x: 20, y: 30, button: 'left', clickCount: 1 };
  const first = manager.humanInput(browser.id, lease.epoch, click);
  const queued = manager.humanInput(browser.id, lease.epoch, click);
  await Promise.resolve(); await Promise.resolve();
  const returning = manager.release(browser.id, lease.epoch);
  assert.equal(manager.list()[0]!.state, 'returning'); assert.equal(driver.calls.includes('snapshot -i'), false);
  unblock(); await first; await queued; const result = await returning;
  assert.equal(result.cancelledInputs, 1); assert.equal(driver.calls.filter(call => call === 'input_mouse').length, 1);
  assert.deepEqual(driver.calls.slice(-4), ['input_mouse', 'pause', 'snapshot -i', 'resume']);
  await manager.takeover(browser.id); assert.equal(manager.list()[0]!.cancelledInputs, undefined);
  await manager.close();
});

test('retired daemon cannot certify a replacement capture from surviving old descendants', async () => {
  const daemon = spawn(process.execPath, ['-e', `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => daemon.once('exit', () => resolve()));
  const owned = new BrowserProcesses(daemon.pid!); let childPid = 0;
  try {
    childPid = await new Promise<number>(resolve => daemon.stdout.once('data', data => resolve(Number(String(data).trim()))));
    await owned.capture(true); daemon.kill('SIGKILL'); await exited; owned.retireRoot();
    await assert.rejects(owned.capture(true), /root exited/);
    await assert.rejects(owned.cleanup(), /cleanup unknown/);
  } finally { daemon.kill('SIGKILL'); if (childPid > 1) { try { process.kill(-childPid, 'SIGKILL'); } catch {} } await exited; }
});

test('unfinished mouse gesture keeps handback held until an explicit human release', async () => {
  const { driver, manager, owner, browser } = await setup(); const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const down = manager.humanInput(browser.id, lease.epoch, { action: 'input_mouse', type: 'mousePressed', x: 1, y: 2, button: 'left' });
  const up = manager.humanInput(browser.id, lease.epoch, { action: 'input_mouse', type: 'mouseReleased', button: 'left' });
  await Promise.resolve(); await Promise.resolve();
  const returning = manager.release(browser.id, lease.epoch); unblock(); await down; await up;
  const held = await returning;
  assert.equal(held.state, 'held'); assert.equal(held.cancelledInputs, 1); assert.deepEqual(held.pressedButtons, ['left']);
  assert.equal(driver.calls.includes('snapshot -i'), false);
  await assert.rejects(owner.command(browser.id, ['snapshot']), BrowserControlError);
  const resumed = await manager.takeover(browser.id);
  await manager.humanInput(browser.id, resumed.epoch, { action: 'input_mouse', type: 'mouseReleased', button: 'left' });
  const returned = await manager.release(browser.id, resumed.epoch);
  assert.equal(returned.state, 'agent'); assert.deepEqual(returned.pressedButtons, []);
  await manager.close();
});


test('completed browser tombstones are bounded and do not exhaust active capacity', async () => {
  const driver = new FakeDriver(); const manager = new BrowserManager({ driver }); const owner = manager.bind('main');
  let first = '';
  for (let i = 0; i < 70; i++) { const browser = await owner.open('https://example.test'); first ||= browser.id; await owner.close(browser.id); }
  assert.ok(manager.list().length <= 64); assert.equal(manager.list().some(browser => browser.id === first), false);
  await assert.rejects(owner.command(first, ['snapshot']), BrowserControlError);
  const live = await owner.open('https://example.test'); assert.equal(live.state, 'agent');
  await manager.close();
});
