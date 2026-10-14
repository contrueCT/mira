/** Private per-terminal supervisor. IPC disconnect is a lifecycle boundary, not a daemon. */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { IPty } from 'node-pty';

let pipe: ChildProcessWithoutNullStreams | undefined;
let pty: IPty | undefined;
let pid: number | undefined;
let stopping = false, sourceClosed = false, cleanupDone = false, overflow = false;
let sending = 0, pendingBytes = 0, inputBytes = 0;
const pending: number[] = [];
const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
let stopTimer: NodeJS.Timeout | undefined;
function finish(): void {
  if (stopping && cleanupDone && sourceClosed && sending === 0) { clearTimeout(stopTimer); process.exit(0); }
}
function send(message: unknown): void {
  if (!process.connected) return;
  sending++;
  process.send?.(message, () => { sending--; finish(); });
}
function resume(): void { if (!pending.length || !process.connected) { pipe?.stdout.resume(); pipe?.stderr.resume(); } }
function output(text: string): void {
  if (!text || !process.connected || overflow) return;
  const bytes = Buffer.byteLength(text);
  // node-pty destroys its socket 200ms after child exit. Never pause it waiting for disk.
  if (pendingBytes + bytes > 1024 * 1024) {
    overflow = true; send({ type: 'output_limit' }); void stop(); return;
  }
  pending.push(bytes); pendingBytes += bytes;
  pipe?.stdout.pause(); pipe?.stderr.pause();
  send({ type: 'data', text });
}
function kill(target: number, signal: NodeJS.Signals): void {
  try { process.kill(target, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function descendants(root: number): Promise<number[]> {
  return new Promise(resolve => execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) { send({ type: 'cleanup_unknown' }); resolve([]); return; }
    const rows = stdout.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const found = new Set([root]);
    for (let changed = true; changed;) { changed = false; for (const [child, parent] of rows) if (child && parent && found.has(parent) && !found.has(child)) { found.add(child); changed = true; } }
    found.delete(root); resolve([...found].reverse());
  }));
}
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const root = pid;
  if (root) {
    const children = await descendants(root);
    for (const child of children) { try { kill(child, 'SIGKILL'); } catch { send({ type: 'cleanup_unknown' }); } }
    try { kill(-root, 'SIGKILL'); } catch { send({ type: 'cleanup_unknown' }); }
    if (!sourceClosed) { try { kill(root, 'SIGKILL'); } catch { send({ type: 'cleanup_unknown' }); } }
  } else sourceClosed = true;
  cleanupDone = true;
  pipe?.stdin.destroy(); resume();
  if (!process.connected) { process.exit(0); return; }
  // A descendant that deliberately escaped may still hold inherited pipe descriptors.
  // Bound shutdown and report incomplete output, rather than silently fabricating EOF.
  const expire = () => {
    // Do not punish a slow durable writer while accepted output is still draining.
    if (pending.length) { stopTimer = setTimeout(expire, 100); return; }
    send({ type: 'output_incomplete' }); sourceClosed = true;
    pipe?.stdout.destroy(); pipe?.stderr.destroy(); finish();
  };
  stopTimer = setTimeout(expire, 2000);
  finish();
}
process.on('disconnect', () => { if (stopping && cleanupDone) process.exit(0); else void stop(); });
process.on('SIGTERM', () => { void stop(); });
type Message = { type: string; command?: string; cwd?: string; shell?: string; tty?: boolean; text?: string; request?: string; discard_output?: boolean };
const queued: Message[] = [];
function input(message: Message): void {
  if (stopping) { send({ type: 'input_rejected', request: message.request }); return; }
  if (!pid) { queued.push(message); return; }
  const bytes = Buffer.byteLength(message.text ?? '');
  if (bytes > 32_768 || inputBytes + bytes > 1024 * 1024) { send({ type: 'input_rejected', request: message.request }); return; }
  try {
    if (message.type === 'interrupt') { if (pty) pty.write('\x03'); else kill(-pid, 'SIGINT'); }
    else {
      inputBytes += bytes;
      if (pty) pty.write(message.text ?? '');
      else pipe?.stdin.write(message.text ?? '');
    }
    // This acknowledges bounded supervisor queue acceptance, not child consumption/effect.
    send({ type: 'accepted', request: message.request, inputBytes });
  } catch { send({ type: 'input_error', request: message.request }); }
}
process.on('message', (message: Message) => {
  if (message.type === 'ack') { pendingBytes -= pending.shift() ?? 0; resume(); return; }
  if (message.type === 'close') {
    if (message.discard_output) { overflow = true; pending.length = 0; pendingBytes = 0; resume(); }
    void stop(); return;
  }
  if (message.type === 'write' || message.type === 'interrupt') { input(message); return; }
  if (message.type !== 'start' || pid || stopping) return;
  void (async () => {
    try {
      if (!['linux', 'darwin'].includes(process.platform)) throw Error('Unsupported terminal platform');
      const shell = message.shell ?? '/bin/bash';
      if (message.tty) {
        const native = await import('node-pty');
        if (stopping || !process.connected) return;
        pty = native.spawn(shell, ['-c', message.command!], { cwd: message.cwd!, env: process.env as Record<string, string>, name: 'xterm-256color', cols: 120, rows: 30 });
        pid = pty.pid;
        pty.onData(output);
        pty.onExit(({ exitCode, signal }) => {
          sourceClosed = true; send({ type: 'exit', code: signal ? null : exitCode, signal: signal ?? null });
          if (stopping) finish(); else void stop();
        });
      } else {
        pipe = spawn(shell, ['-c', message.command!], { cwd: message.cwd!, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        pid = pipe.pid;
        pipe.stdout.on('data', (data: Buffer) => output(decoders[0]!.write(data)));
        pipe.stderr.on('data', (data: Buffer) => output(decoders[1]!.write(data)));
        pipe.stdin.on('error', () => {});
        pipe.once('error', () => { sourceClosed = true; send({ type: 'error', error: 'spawn_failed' }); void stop(); });
        pipe.once('exit', (code, signal) => { send({ type: 'process_exit', code, signal }); void stop(); });
        pipe.once('close', (code, signal) => {
          for (const decoder of decoders) output(decoder.end()); sourceClosed = true;
          send({ type: 'exit', code, signal }); if (stopping) finish(); else void stop();
        });
      }
      send({ type: 'started', pid });
      for (const message of queued.splice(0)) input(message);
    } catch { sourceClosed = true; send({ type: 'error', error: message.tty ? 'pty_unavailable' : 'spawn_failed' }); void stop(); }
  })();
});
