import { hostCapabilityTestEnvironment, maySkipUnavailableHostSocket } from '../host-capabilities.mts';
import { diagnosticText, startupEvidence, startupProbePassed } from '../e2e/browser-native-probe.mts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { BrowserProcesses } from '../../apps/server/src/browser-processes.ts';
import { mkdir, mkdtemp, writeFile, chmod, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserManager, BrowserControlError } from '../../apps/server/src/browser-manager.ts';
import { AgentBrowserDriver, browserProtocolCommand, browserHumanInput, type BrowserDriver } from '../../apps/server/src/browser-driver.ts';

class FakeDriver implements BrowserDriver {
  calls: string[] = [];
  argv: string[][] = [];
  exitListener: ((session: string) => void) | undefined;
  onExit(listener: (session: string) => void) { this.exitListener = listener; return () => { this.exitListener = undefined; }; }
  gate: Promise<void> | undefined;
  fail = false;
  failOpen = false;
  failStream = false;
  async open(session: string, url: string) { this.calls.push(`open:${session}:${url}`); if (this.failOpen) throw Error('open failed'); return {}; }
  async command(_session: string, args: readonly string[]) { this.argv.push([...args]); this.calls.push(args.join(' ')); await this.gate; if (this.fail) throw Error('secret upstream failure'); return { snapshot: 'page' }; }
  async humanInput(_session: string, input: Record<string, unknown>) { this.calls.push(String(input.action)); await this.gate; if (this.fail) throw Error('unknown input'); }
  async stream() { this.calls.push('stream'); if (this.failStream) throw Error('stream down'); return 'ws://127.0.0.1:12345'; }
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
  const executable = path.join(base, 'fake-native'); const log = path.join(base, 'commands.jsonl'); const failure = path.join(base, 'failure'); const descendant = path.join(base, 'descendant'); const relaunch = path.join(base, 'relaunch'); const rejectLaunch = path.join(base, 'reject-launch');
  const session = '11111111-1111-1111-1111-111111111111';
  const script = `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('agent-browser 0.39.1'); process.exit(0); }
const dir = process.env.AGENT_BROWSER_SOCKET_DIR, session = process.env.AGENT_BROWSER_SESSION;
fs.writeFileSync(path.join(dir, session + '.pid'), String(process.pid));
const server = net.createServer(socket => { let text = ''; socket.on('data', chunk => { text += chunk; if (!text.includes('\\n')) return; const cmd = JSON.parse(text.split('\\n')[0]); if (cmd.action === 'launch' && fs.existsSync(${JSON.stringify(rejectLaunch)})) { socket.end(JSON.stringify({id:cmd.id,success:false,error:'synthetic-startup-private-detail'}) + '\\n'); return; } if (cmd.action === 'launch' || (cmd.action === 'snapshot' && fs.existsSync(${JSON.stringify(relaunch)}))) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true, stdio:'ignore'}); fs.appendFileSync(${JSON.stringify(descendant)}, String(child.pid) + '\\n'); } fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ action: cmd.action, pid: process.pid, directory: dir, engine: process.env.AGENT_BROWSER_ENGINE, requestedEngine: cmd.engine }) + '\\n'); socket.end(JSON.stringify({ id: cmd.id, success: true, data: { ...(cmd.action === 'stream_status' ? {enabled: true, port: 12345} : {ok: true}), lifecycle: { launched: cmd.action === 'launch', relaunchedBrowser: fs.existsSync(${JSON.stringify(relaunch)}) && cmd.action === 'snapshot', restartedBackground: false } } }) + '\\n'); if (cmd.action === 'close') server.close(() => process.exit(0)); }); });
server.on('error', e => { fs.writeFileSync(${JSON.stringify(failure)}, e.code || 'unknown'); process.exit(1); });
server.listen(path.join(dir, session + '.sock'));
`;
  const driver = new AgentBrowserDriver({ executable, cwd: base });
  try {
    await writeFile(executable, script); await chmod(executable, 0o700);
    try { await driver.open(session, 'https://example.com'); }
    catch (error) { if (maySkipUnavailableHostSocket(await readFile(failure, 'utf8').catch(() => ''), process.env)) { t.skip('Host prohibits Unix sockets; real daemon transport gate is blocked'); return; } throw error; }
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
    await writeFile(rejectLaunch, '1');
    await assert.rejects(driver.open('22222222-2222-2222-2222-222222222222', 'https://example.com'), error => {
      assert.match(String(error), /native launch failed.*cleanup confirmed/);
      assert.equal(String(error).includes('synthetic-startup-private-detail'), false); return true;
    });
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


test('unknown outcome lock is viewable and still rejects input; cleanup lock is not', async () => {
  const { driver, manager, owner, browser } = await setup(); driver.fail = true;
  await assert.rejects(owner.command(browser.id, ['snapshot']), /unknown/);
  driver.fail = false;
  const locked = manager.list()[0]!;
  assert.equal(locked.state, 'unknown'); assert.equal(locked.lock, 'outcome');
  assert.equal(await manager.stream(locked.id), 'ws://127.0.0.1:12345');
  await assert.rejects(manager.takeover(locked.id), BrowserControlError);
  await assert.rejects(manager.humanInput(locked.id, locked.epoch, { action: 'press', key: 'Enter' }), BrowserControlError);
  await assert.rejects(manager.release(locked.id, locked.epoch), BrowserControlError);
  await assert.rejects(owner.command(locked.id, ['snapshot']), /not under agent/);
  const epoch = locked.epoch; driver.failStream = true;
  await assert.rejects(manager.stream(locked.id), /stream unavailable/);
  assert.equal(manager.list()[0]!.state, 'unknown'); assert.equal(manager.list()[0]!.lock, 'outcome'); assert.equal(manager.list()[0]!.epoch, epoch);
  driver.failStream = false; driver.fail = true;
  await assert.rejects(owner.close(locked.id), /Cleanup/);
  assert.equal(manager.list()[0]!.lock, 'cleanup');
  const streams = driver.calls.filter(call => call === 'stream').length;
  await assert.rejects(manager.stream(locked.id), /Browser stream unavailable/);
  assert.equal(driver.calls.filter(call => call === 'stream').length, streams);
  await manager.close();
});

test('user reopen replaces a locked browser at the last opened address', async () => {
  const { driver, manager, owner, browser } = await setup();
  await assert.rejects(manager.reopen(browser.id, browser.epoch), /not locked in an indeterminate state/);
  await assert.rejects(manager.reopen(browser.id, browser.epoch + 1), /not locked in an indeterminate state/);
  const snapshot = await owner.command(browser.id, ['snapshot', '-i']);
  await owner.command(browser.id, ['open', 'https://example.org/path'], snapshot.observation);
  driver.fail = true;
  await assert.rejects(owner.command(browser.id, ['snapshot']), /unknown/);
  const locked = manager.list().find(item => item.id === browser.id)!;
  assert.equal(locked.lock, 'outcome');
  await assert.rejects(manager.reopen(locked.id, locked.epoch + 1), /not locked in an indeterminate state/);
  driver.fail = false;
  const fresh = await manager.reopen(locked.id, locked.epoch);
  assert.equal(driver.calls.filter(call => call === 'close').length, 1);
  assert.ok(driver.calls.at(-1)!.endsWith('https://example.org/path'));
  assert.equal(fresh.state, 'agent'); assert.equal(fresh.replaces, browser.id); assert.equal(fresh.ownerLabel, 'Mira');
  assert.equal(fresh.message, 'Opened fresh by the user to replace browser ' + browser.id + ' (same address, new page; nothing carried over). Take a fresh snapshot before acting.');
  const old = manager.list().find(item => item.id === browser.id)!;
  assert.equal(old.state, 'closed'); assert.equal(old.replacedBy, fresh.id);
  assert.equal(old.message, 'Closed and reopened by the user after an indeterminate outcome. The previous page, its state and element references are gone; use browser ' + fresh.id + ' after a fresh snapshot.');
  assert.equal(JSON.stringify(manager.list()).includes('https://example.org/path'), false);
  assert.equal(owner.list().some(item => item.id === fresh.id), true);
  assert.equal(manager.bind('child').list().some(item => item.id === fresh.id), false);
  await assert.rejects(owner.command(browser.id, ['snapshot']), /closed and reopened by the user/);
  await owner.close(browser.id);
  assert.equal(driver.calls.filter(call => call === 'close').length, 1);
  await assert.rejects(manager.reopen(browser.id, locked.epoch), /not locked in an indeterminate state/);
  const observed = await owner.command(fresh.id, ['snapshot', '-i']);
  assert.equal(observed.message, undefined);
  await manager.close();
});

test('reopen waits for an in-flight command and never opens before close finishes', async () => {
  const { driver, manager, owner, browser } = await setup();
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const pending = owner.command(browser.id, ['snapshot']);
  await Promise.resolve(); await Promise.resolve();
  const session = driver.calls[0]!.slice('open:'.length).split(':')[0]!;
  driver.exitListener?.(session);
  const locked = manager.list()[0]!;
  assert.equal(locked.state, 'unknown'); assert.equal(locked.lock, 'outcome');
  const reopening = manager.reopen(locked.id, locked.epoch);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(driver.calls.includes('close'), false);
  assert.equal(driver.calls.filter(call => call.startsWith('open:')).length, 1);
  unblock();
  const fresh = await reopening; await pending;
  const closeAt = driver.calls.indexOf('close');
  const reopenAt = driver.calls.findIndex((call, index) => index > 0 && call.startsWith('open:'));
  assert.ok(driver.calls.indexOf('snapshot') < closeAt && closeAt < reopenAt);
  assert.equal(driver.calls.filter(call => call === 'close').length, 1);
  assert.equal(fresh.replaces, browser.id);
  await manager.close();
});

test('reopen does not open a browser when close cannot be verified', async () => {
  const { driver, manager, owner, browser } = await setup(); driver.fail = true;
  await assert.rejects(owner.command(browser.id, ['snapshot']), /unknown/);
  const locked = manager.list()[0]!;
  const opens = driver.calls.filter(call => call.startsWith('open:')).length;
  await assert.rejects(manager.reopen(locked.id, locked.epoch), /could not be verified/);
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0]!.state, 'unknown'); assert.equal(manager.list()[0]!.lock, 'cleanup');
  assert.equal(driver.calls.filter(call => call.startsWith('open:')).length, opens);
  await manager.close();
});

test('reopen rejects a locked browser when no address was opened', async () => {
  const driver = new FakeDriver(); driver.failOpen = true; const manager = new BrowserManager({ driver });
  await assert.rejects(manager.bind('main').open('https://example.com/start'), /could not be opened/);
  const locked = manager.list()[0]!;
  assert.equal(locked.state, 'unknown'); assert.equal(locked.lock, 'outcome');
  await assert.rejects(manager.reopen(locked.id, locked.epoch), /No address is known/);
  assert.equal(manager.list().length, 1);
  assert.equal(driver.calls.filter(call => call.startsWith('open:')).length, 1);
  await manager.close();
});

test('reopen still links the replacement when the fresh open cannot be verified', async () => {
  const { driver, manager, owner, browser } = await setup(); driver.fail = true;
  await assert.rejects(owner.command(browser.id, ['snapshot']), /unknown/);
  driver.fail = false; driver.failOpen = true;
  const locked = manager.list()[0]!;
  await assert.rejects(manager.reopen(locked.id, locked.epoch), /could not be opened/);
  const sessions = manager.list();
  assert.equal(sessions.length, 2);
  const old = sessions.find(item => item.id === browser.id)!;
  const fresh = sessions.find(item => item.id !== browser.id)!;
  assert.equal(old.state, 'closed'); assert.equal(old.replacedBy, fresh.id);
  assert.equal(fresh.replaces, browser.id); assert.equal(fresh.state, 'unknown'); assert.equal(fresh.lock, 'outcome');
  await manager.close();
});

test('synthetic startup evidence is byte bounded and projects only diagnostic fields', () => {
  for (const text of ['x'.repeat(100000), '文'.repeat(100000), '\0'.repeat(100000), '😀'.repeat(100000)]) {
    const result = diagnosticText(text); assert.ok(Buffer.byteLength(JSON.stringify(result.text)) <= 4096); assert.equal(result.truncated, true);
    const evidence = startupEvidence({ success: false, error: text, unneeded: text });
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 4200); assert.equal('unneeded' in evidence, false);
  }
  assert.deepEqual(diagnosticText('short'), { text: 'short', truncated: false });
});


test('startup probe verdict rejects native close rejection and uncertain command cleanup', () => {
  const good = { launch: { success: true }, close: { success: true }, ownedBrowserCaptured: true, cleanup: 'confirmed' };
  assert.equal(startupProbePassed(good), true);
  for (const patch of [{ close: { success: false } }, { close: undefined }, { probeError: { text: 'lost reply' } }, { cleanup: 'unknown' }]) assert.equal(startupProbePassed({ ...good, ...patch }), false);
});


test('isolated test harness preserves strict socket requirement without forwarding CI to browsers', () => {
  const strict = hostCapabilityTestEnvironment({ CI: 'true' });
  assert.deepEqual(strict, { MIRA_TEST_REQUIRE_HOST_SOCKETS: '1' });
  assert.equal(maySkipUnavailableHostSocket('EPERM', strict), false);
  assert.equal(maySkipUnavailableHostSocket('EPERM', {}), true);
  assert.equal(maySkipUnavailableHostSocket('EACCES', {}), false);
  assert.equal('CI' in strict, false);
});


test('managed browser discovers a later skill-prefix install and keeps explicit executable priority', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mira-browser-discovery-'));
  const previous = process.env['MIRA_AGENT_BROWSER_EXECUTABLE']; delete process.env['MIRA_AGENT_BROWSER_EXECUTABLE'];
  const previousPath = process.env['PATH'];
  try {
    const old = path.join(home, 'old'); await mkdir(old);
    const oldLauncher = path.join(old, 'agent-browser.js');
    await writeFile(oldLauncher, '// official-layout fixture'); await chmod(oldLauncher, 0o700);
    await symlink(oldLauncher, path.join(old, 'agent-browser'));
    process.env['PATH'] = old;
    const driver = new AgentBrowserDriver({ miraHome: home });
    const bin = path.join(home, 'tools', 'agent-browser', 'node_modules', 'agent-browser', 'bin');
    await mkdir(bin, { recursive: true });
    const launcher = path.join(bin, 'agent-browser.js'); await writeFile(launcher, '// official-layout fixture, never executed'); await chmod(launcher, 0o700);
    const glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
    const platform = process.platform === 'linux' && !glibc ? 'linux-musl' : process.platform;
    const native = path.join(bin, `agent-browser-${platform}-${process.arch}`);
    const log = path.join(home, 'selected');
    const oldNative = path.join(old, path.basename(native));
    await writeFile(oldNative, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, 'old-path'); console.log('agent-browser 0.1.0');`); await chmod(oldNative, 0o700);
    // Temporarily remove the standard launcher to reproduce first resolution via PATH.
    await rm(launcher);
    await assert.rejects(driver.open('22222222-2222-2222-2222-222222222222', 'https://example.test'), /pinned/);
    assert.equal(await readFile(log, 'utf8'), 'old-path');
    await writeFile(launcher, '// official-layout fixture'); await chmod(launcher, 0o700);
    await writeFile(native, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, 'skill-prefix'); console.log('agent-browser 9.9.9');`); await chmod(native, 0o700);
    await assert.rejects(driver.open('33333333-3333-3333-3333-333333333333', 'https://example.test'), /pinned/);
    assert.equal(await readFile(log, 'utf8'), 'skill-prefix');
    const override = path.join(home, 'override');
    await writeFile(override, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, 'explicit'); console.log('agent-browser 9.9.9');`); await chmod(override, 0o700);
    const explicit = new AgentBrowserDriver({ miraHome: home, executable: override });
    await assert.rejects(explicit.open('44444444-4444-4444-4444-444444444444', 'https://example.test'), /pinned/);
    assert.equal(await readFile(log, 'utf8'), 'explicit');
  } finally { if (previousPath === undefined) delete process.env['PATH']; else process.env['PATH'] = previousPath; if (previous === undefined) delete process.env['MIRA_AGENT_BROWSER_EXECUTABLE']; else process.env['MIRA_AGENT_BROWSER_EXECUTABLE'] = previous; await rm(home, { recursive: true, force: true }); }
});

test('human navigation rejects without the current lease and rejects unsafe addresses before the driver', async () => {
  const { driver, manager, browser } = await setup();
  await assert.rejects(manager.humanNavigate(browser.id, browser.epoch, { kind: 'open', url: 'https://example.org/user-opened' }), /human control lease/);
  const lease = await manager.takeover(browser.id);
  manager.disconnect(browser.id, lease.epoch);
  const held = manager.list()[0]!;
  assert.equal(held.state, 'held');
  await assert.rejects(manager.humanNavigate(browser.id, held.epoch, { kind: 'open', url: 'https://example.org/user-opened' }), /human control lease/);
  const again = await manager.takeover(browser.id);
  await assert.rejects(manager.humanNavigate(browser.id, again.epoch - 1, { kind: 'open', url: 'https://example.org/user-opened' }), /human control lease/);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://user:pw@x.test/', 'https://example.org/' + 'a'.repeat(2048)]) {
    await assert.rejects(manager.humanNavigate(browser.id, again.epoch, { kind: 'open', url }), /Only http\(s\) addresses without credentials can be opened/);
  }
  for (const tabId of ['../etc', 'tab id', '', 'a'.repeat(129)]) await assert.rejects(manager.humanNavigate(browser.id, again.epoch, { kind: 'tab', tabId }), /Invalid tab id/);
  assert.equal(driver.argv.length, 0);
  await manager.close();
});

test('human navigation runs on the session queue and tells Mira until the next agent snapshot', async () => {
  const { driver, manager, owner, browser } = await setup();
  const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const opening = manager.humanNavigate(browser.id, lease.epoch, { kind: 'open', url: 'https://example.org/user-opened' });
  const switching = manager.humanNavigate(browser.id, lease.epoch, { kind: 'tab', tabId: 't2' });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(driver.argv, [['open', 'https://example.org/user-opened']]);
  unblock();
  const opened = await opening; const switched = await switching;
  assert.deepEqual(driver.argv, [['open', 'https://example.org/user-opened'], ['tab', 't2']]);
  assert.equal(opened.state, 'human'); assert.equal(opened.message, undefined);
  assert.deepEqual(switched.userActivity, { navigations: 1, tabSwitches: 1, domain: 'example.org' });
  assert.equal(JSON.stringify(manager.list()).includes('user-opened'), false);
  const returned = await manager.release(browser.id, lease.epoch);
  assert.equal(returned.state, 'agent');
  assert.equal(returned.message, 'While under user control the user navigated 1 time(s) and switched tabs 1 time(s) (last site: example.org). The current page and tabs may differ from your last observation; take a fresh snapshot before acting.');
  assert.deepEqual(returned.userActivity, { navigations: 1, tabSwitches: 1, domain: 'example.org' });
  const snap = await owner.command(browser.id, ['snapshot']);
  assert.equal(snap.userActivity, undefined); assert.equal(snap.message, undefined); assert.equal(manager.list()[0]!.userActivity, undefined);
  driver.fail = true;
  await assert.rejects(owner.command(browser.id, ['click', '@e1'], snap.observation), /unknown/);
  driver.fail = false;
  const locked = manager.list().find(item => item.id === browser.id)!;
  const fresh = await manager.reopen(locked.id, locked.epoch);
  assert.equal(fresh.domain, 'example.org');
  assert.match(driver.calls.filter(call => call.startsWith('open:')).at(-1)!, /https:\/\/example\.org\/user-opened$/);
  assert.equal(JSON.stringify(manager.list()).includes('user-opened'), false);
  await manager.close();
});

test('failed human navigation becomes unknown and is not replayed', async () => {
  const { driver, manager, browser } = await setup(); const lease = await manager.takeover(browser.id); driver.fail = true;
  await assert.rejects(manager.humanNavigate(browser.id, lease.epoch, { kind: 'open', url: 'https://example.org/user-opened' }), /not replayed/);
  assert.equal(manager.list()[0]!.state, 'unknown'); assert.equal(manager.list()[0]!.userActivity, undefined);
  assert.deepEqual(driver.argv, [['open', 'https://example.org/user-opened']]);
  driver.fail = false;
  await assert.rejects(manager.humanNavigate(browser.id, lease.epoch, { kind: 'open', url: 'https://example.org/again' }), /human control lease/);
  assert.deepEqual(driver.argv, [['open', 'https://example.org/user-opened']]);
  await manager.close();
});

test('queued human navigation is not run when control changes before it starts', async () => {
  const { driver, manager, browser } = await setup(); const lease = await manager.takeover(browser.id);
  let unblock!: () => void; driver.gate = new Promise(resolve => { unblock = resolve; });
  const input = manager.humanInput(browser.id, lease.epoch, { action: 'inserttext', text: 'hold the queue' });
  const nav = manager.humanNavigate(browser.id, lease.epoch, { kind: 'open', url: 'https://example.org/queued' });
  const rejected = assert.rejects(nav, /control changed before navigation started/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(driver.calls.includes('inserttext'), true); assert.equal(driver.argv.length, 0);
  const returning = manager.release(browser.id, lease.epoch);
  assert.equal(manager.list()[0]!.state, 'returning');
  unblock(); await input; await rejected; const returned = await returning;
  assert.equal(returned.state, 'agent');
  assert.equal(driver.argv.some(args => args[0] === 'open'), false);
  assert.equal(JSON.stringify(driver.argv).includes('example.org/queued'), false);
  await manager.close();
});
