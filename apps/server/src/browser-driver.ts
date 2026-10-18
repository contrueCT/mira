import { BrowserProcesses } from './browser-processes.ts';
import { browserLaunchEnvironment, managedBrowserExecutable } from './browser-launch.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, lstat, readFile, rm, realpath, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import { get } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

export interface BrowserDriver {
  onExit?(listener: (session: string) => void): () => void;
  open(session: string, url: string): Promise<unknown>;
  command(session: string, args: readonly string[]): Promise<unknown>;
  humanInput(session: string, input: Record<string, unknown>): Promise<void>;
  stream(session: string): Promise<string>;
  pauseStream(session: string): Promise<void>;
  resumeStream(session: string): Promise<void>;
  close(session: string): Promise<void>;
  dispose(): Promise<void>;
}
function validUrl(value: string): void { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Browser URL must be HTTP(S), without embedded credentials'); }
/** A deliberately small argv subset, mapped to the pinned upstream command protocol. */
export function browserProtocolCommand(args: readonly string[]): Record<string, unknown> {
  if (!Array.isArray(args) || args.length < 1 || args.length > 16 || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 32_768)) throw Error('Invalid browser command');
  const [command, ...rest] = args;
  const exact = (n: number) => { if (rest.length !== n) throw Error('Invalid browser command arguments'); };
  const selector = () => { if (!rest[0] || rest[0].startsWith('-')) throw Error('Invalid browser selector'); return rest[0]; };
  if (command === 'snapshot') { if (rest.some(a => !['-i', '-c', '-u', '--interactive', '--compact', '--urls'].includes(a))) throw Error('Unsupported snapshot option'); return { action: 'snapshot', interactive: rest.includes('-i') || rest.includes('--interactive'), compact: rest.includes('-c') || rest.includes('--compact'), urls: rest.includes('-u') || rest.includes('--urls') }; }
  if (command === 'open') { exact(1); validUrl(rest[0]!); return { action: 'navigate', url: rest[0] }; }
  if (['back', 'forward', 'reload'].includes(command!)) { exact(0); return { action: command }; }
  if (['click', 'dblclick', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview'].includes(command!)) { exact(1); return { action: command, selector: selector() }; }
  if (command === 'fill' || command === 'type') { exact(2); return { action: command, selector: selector(), [command === 'fill' ? 'value' : 'text']: rest[1] }; }
  if (command === 'press') { exact(1); if (!rest[0] || rest[0].startsWith('-')) throw Error('Invalid browser key'); return { action: 'press', key: rest[0] }; }
  if (command === 'select') { if (rest.length < 2) throw Error('Select requires values'); return { action: 'select', selector: selector(), values: rest.length === 2 ? rest[1] : rest.slice(1) }; }
  if (command === 'scroll') { exact(2); if (!['up', 'down', 'left', 'right'].includes(rest[0]!) || !/^\d{1,5}$/.test(rest[1]!)) throw Error('Invalid browser scroll'); return { action: 'scroll', direction: rest[0], amount: Number(rest[1]) }; }
  if (command === 'get') { const actions: Record<string, string> = { text: 'gettext', html: 'innerhtml', value: 'inputvalue', count: 'count', box: 'boundingbox', title: 'title', url: 'url' }; const action = actions[rest[0]!]; if (!action) throw Error('Unsupported browser get'); exact(['url', 'title'].includes(rest[0]!) ? 1 : 2); return { action, ...(rest.length === 2 ? { selector: rest[1] } : {}) }; }
  if (command === 'tab') { if (rest.length === 0 || (rest.length === 1 && rest[0] === 'list')) return { action: 'tab_list' }; if (rest[0] === 'new') { exact(2); validUrl(rest[1]!); return { action: 'tab_new', url: rest[1] }; } if (rest[0] === 'close') { if (rest.length > 2) throw Error('Invalid tab close'); return { action: 'tab_close', ...(rest[1] ? { tabId: rest[1] } : {}) }; } exact(1); if (!/^[\w-]{1,128}$/.test(rest[0]!)) throw Error('Invalid tab id'); return { action: 'tab_switch', tabId: rest[0] }; }
  throw Error('Unsupported managed browser command; config, sessions, remote engines, eval, filesystem and stream flags are not accepted');
}
export function validateBrowserCommand(args: readonly string[]): void { browserProtocolCommand(args); }
/** Typed human input never passes through model tools, history, or raw stream dispatch. */
export function browserHumanInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid human browser input');
  const keys = (allowed: string[]) => { if (Object.keys(input).some(key => !allowed.includes(key))) throw Error('Unsupported human browser input field'); };
  if (input.action === 'inserttext' || input.action === 'press') {
    const field = input.action === 'inserttext' ? 'text' : 'key'; keys(['action', field]);
    const value = input[field]; if (typeof value !== 'string' || value.includes('\0') || value.length > (field === 'text' ? 16_384 : 128) || (field === 'key' && !value)) throw Error('Invalid human browser text or key');
    return { action: input.action, [field]: value };
  }
  if (input.action !== 'input_mouse') throw Error('Unsupported human browser input');
  keys(['action', 'type', 'x', 'y', 'button', 'clickCount', 'deltaX', 'deltaY', 'modifiers']);
  if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(input.type))) throw Error('Invalid human mouse event');
  const output: Record<string, unknown> = { action: 'input_mouse', type: input.type };
  for (const key of ['x', 'y', 'deltaX', 'deltaY', 'clickCount', 'modifiers']) {
    const value = input[key]; if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000 || (['x', 'y'].includes(key) && value < 0) || (key === 'clickCount' && (!Number.isInteger(value) || value < 0 || value > 3)) || (key === 'modifiers' && (!Number.isInteger(value) || value < 0 || value > 15))) throw Error('Invalid human mouse coordinate or modifier');
    output[key] = value;
  }
  if (input.button !== undefined) { if (!['none', 'left', 'right', 'middle'].includes(String(input.button))) throw Error('Invalid human mouse button'); output.button = input.button; }
  return output;
}
interface Handle { directory: string; socket: string; dev: number; ino: number; pid: number; process: ChildProcess; exited: Promise<void>; owned: BrowserProcesses; invalid: boolean }
/** Supervises the official native daemon directly; never invokes CLI auto-respawn or replays requests. Unix hosts only. */
export class AgentBrowserDriver implements BrowserDriver {
  readonly #handles = new Map<string, Handle>();
  readonly #exitListeners = new Set<(session: string) => void>();
  onExit(listener: (session: string) => void): () => void { this.#exitListeners.add(listener); return () => { this.#exitListeners.delete(listener); }; }
  #notifyExit(session: string): void { const h = this.#handles.get(session); if (h) h.invalid = true; for (const listener of this.#exitListeners) { try { listener(session); } catch { /* Lifecycle observers cannot affect cleanup. */ } } }
  readonly #executable: string;
  readonly #explicitExecutable: boolean;
  #resolved: string | undefined;
  readonly #cwd: string;
  readonly #miraHome: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #browserExecutable: string | undefined;
  constructor(options: { cwd?: string; executable?: string; miraHome?: string } = {}) {
    this.#explicitExecutable = options.executable !== undefined || process.env['MIRA_AGENT_BROWSER_EXECUTABLE'] !== undefined;
    this.#executable = options.executable ?? process.env['MIRA_AGENT_BROWSER_EXECUTABLE'] ?? 'agent-browser'; this.#cwd = options.cwd ?? process.cwd();
    this.#miraHome = options.miraHome ?? process.env['MIRA_HOME'] ?? path.join(homedir(), '.mira');
    this.#env = browserLaunchEnvironment(process.env);
    this.#browserExecutable = process.env['MIRA_BROWSER_EXECUTABLE_PATH'];
  }
  #run(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#resolved ?? this.#executable, args, { cwd: this.#cwd, env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = ''; let bytes = 0; let failed = false;
      const fail = () => { if (failed) return; failed = true; child.kill('SIGKILL'); reject(Error('Pinned browser CLI failed; command outcome may be unknown')); };
      const timer = setTimeout(fail, 45_000);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) fail(); else output += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(timer); fail(); });
      child.on('close', code => { clearTimeout(timer); if (failed) return; if (code !== 0) fail(); else resolve(output); });
    });
  }
  async #resolveExecutable(): Promise<void> {
    // Re-resolve each new session so an on-demand install or replacement is visible.
    const candidates = this.#executable.includes('/') ? [this.#executable] : (this.#env['PATH'] ?? '').split(path.delimiter).map(dir => path.join(dir, this.#executable));
    if (!this.#explicitExecutable) candidates.unshift(path.join(this.#miraHome, 'tools', 'agent-browser', 'node_modules', 'agent-browser', 'bin', 'agent-browser.js'));
    for (const candidate of candidates) {
      try {
        let resolved = await realpath(candidate); await access(resolved, 1);
        if (path.basename(resolved) === 'agent-browser.js') {
          const glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
          const platform = process.platform === 'linux' && !glibc ? 'linux-musl' : process.platform;
          resolved = path.join(path.dirname(resolved), `agent-browser-${platform}-${process.arch}`); await access(resolved, 1);
        } else if (!this.#explicitExecutable) {
          const header = (await readFile(resolved)).subarray(0, 2).toString();
          if (header === '#!') continue; // Never execute shell package-manager shims.
        }
        this.#resolved = resolved; return;
      } catch { /* Try the next PATH entry; never install software. */ }
    }
    throw Error('Install agent-browser 0.39.1 and set MIRA_AGENT_BROWSER_EXECUTABLE to its official native binary');
  }
  async open(session: string, url: string): Promise<unknown> {
    validateBrowserCommand(['open', url]);
    if (process.platform === 'win32') throw Error('Managed browser requires a Unix domain socket host');
    if (!/^[\da-f-]{36}$/.test(session) || this.#handles.has(session)) throw Error('Invalid browser generation');
    await this.#resolveExecutable();
    const version = (await this.#run(['--version'], this.#env)).trim();
    if (version !== 'agent-browser 0.39.1') throw Error('Install the pinned agent-browser 0.39.1 explicitly');
    const browserExecutable = await managedBrowserExecutable(this.#browserExecutable);
    const directory = await mkdtemp(path.join(tmpdir(), 'mira-ab-'));
    const child = spawn(this.#resolved!, [], { cwd: this.#cwd, env: { ...this.#env, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: directory, AGENT_BROWSER_PIN_TAB: '1' }, shell: false, detached: true, stdio: 'ignore' });
    const owned = child.pid ? new BrowserProcesses(child.pid) : undefined;
    let ended = false;
    const exited = new Promise<void>(resolve => { child.once('exit', () => { ended = true; owned?.retireRoot(); this.#notifyExit(session); void owned?.cleanup().catch(() => {}); resolve(); }); child.once('error', () => { ended = true; owned?.retireRoot(); this.#notifyExit(session); void owned?.cleanup().catch(() => {}); resolve(); }); });
    let stage = 'daemon startup';
    try {
      const socket = path.join(directory, `${session}.sock`);
      const deadline = Date.now() + 10_000;
      while (true) {
        if (ended || Date.now() > deadline) throw Error('Browser daemon did not start');
        try {
          const stat = await lstat(socket); const pid = Number(await readFile(path.join(directory, `${session}.pid`), 'utf8'));
          if (!stat.isSocket() || pid !== child.pid) throw Error('Invalid browser daemon identity');
          this.#handles.set(session, { directory, socket, dev: stat.dev, ino: stat.ino, pid, process: child, exited, owned: owned!, invalid: false }); break;
        } catch { await delay(25); }
      }
      stage = 'initial process ownership';
      await owned!.capture();
      stage = 'native launch';
      await this.#request(session, { action: 'launch', headless: true, engine: 'chrome', pinTab: true, plugins: [], ...(browserExecutable ? { executablePath: browserExecutable } : {}) });
      await owned!.capture(true);
      stage = 'initial navigation';
      const output = await this.#request(session, browserProtocolCommand(['open', url]));
      await owned!.capture();
      return output;
    } catch {
      let cleanup = 'confirmed';
      try { await this.#stop(child, exited, owned); } catch { cleanup = 'unknown'; }
      // Preserve the failure phase separately from cleanup, without exposing native
      // errors (which can include paths or page data) through a model tool result.
      if (cleanup === 'confirmed') { this.#handles.delete(session); await rm(directory, { recursive: true, force: true }); }
      throw Error(`Browser ${stage} failed or outcome unknown; owned-process cleanup ${cleanup}`);
    }
  }
  async #stop(child: ChildProcess, exited: Promise<void>, owned?: BrowserProcesses): Promise<void> {
    let cleanupFailed = false;
    try { await owned?.capture(); } catch { cleanupFailed = true; }
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(1000)]);
      try { await owned?.cleanup(); } catch { cleanupFailed = true; child.kill('SIGKILL'); }
    }
    await exited;
    try { await owned?.cleanup(); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw Error('Browser cleanup outcome unknown; some descendants could not be identified');
  }
  async #request(session: string, command: Record<string, unknown>): Promise<unknown> {
    const h = this.#handles.get(session); if (!h) throw Error('No live browser generation');
    if (h.invalid && command.action !== 'close') throw Error('Browser generation invalidated; outcome unknown');
    if (h.process.exitCode !== null || h.process.signalCode !== null) throw Error('Browser daemon ended');
    const stat = await lstat(h.socket); const pid = Number(await readFile(path.join(h.directory, `${session}.pid`), 'utf8'));
    if (!stat.isSocket() || stat.dev !== h.dev || stat.ino !== h.ino || pid !== h.pid) throw Error('Browser generation changed');
    process.kill(h.pid, 0);
    type Response = { id?: string; success?: boolean; data?: { lifecycle?: { launched?: boolean; relaunchedBrowser?: boolean; restartedBackground?: boolean } } };
    let response: Response | undefined;
    try { response = await new Promise<Response>((resolve, reject) => {
      const requestId = randomUUID();
      const socket = connect(h.socket); let bytes = 0; const chunks: Buffer[] = []; let settled = false;
      const finish = (error?: Error, value?: Response) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolve(value!); };
      socket.setTimeout(35_000, () => finish(Error('Browser command timed out; outcome unknown')));
      socket.on('error', () => finish(Error('Browser transport failed; outcome unknown')));
      socket.on('end', () => finish(Error('Browser response ended; outcome unknown')));
      socket.on('connect', () => { socket.write(`${JSON.stringify({ ...command, id: requestId })}\n`); });
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > 1024 * 1024) { finish(Error('Browser output limit; outcome unknown')); return; }
        chunks.push(chunk); const buffer = Buffer.concat(chunks); const end = buffer.indexOf(10); if (end < 0) return;
        try {
          if (buffer.subarray(end + 1).toString('utf8').trim()) throw Error('Trailing browser response');
          const parsed = JSON.parse(buffer.subarray(0, end).toString('utf8')) as Response;
          if (parsed.id !== requestId) throw Error('Mismatched browser response');
          finish(undefined, parsed);
        } catch { finish(Error('Invalid browser response; outcome unknown')); }
      });
    }); } catch (error) {
      // A lost response may leave a still-running native action that spawns after our last capture.
      h.owned.markUnobservableCommand(); throw error;
    } finally {
      // Capture replacement process groups before interpreting lifecycle changes or invalidating.
      try { await h.owned.capture(command.action !== 'close' && !(command.action === 'launch' && response?.success === false)); }
      catch { this.#notifyExit(session); throw Error('Browser ownership capture failed; command and cleanup outcome unknown'); }
    }
    if (response?.success !== true) throw Error('Browser command failed or outcome unknown');
    const lifecycle = response.data?.lifecycle;
    if (!lifecycle || (command.action !== 'launch' && (lifecycle.launched !== false || lifecycle.relaunchedBrowser !== false || lifecycle.restartedBackground !== false))) {
      this.#notifyExit(session); throw Error('Browser instance changed during the command; outcome unknown');
    }
    return response.data;
  }
  command(session: string, args: readonly string[]): Promise<unknown> { return this.#request(session, browserProtocolCommand(args)); }
  async humanInput(session: string, input: Record<string, unknown>): Promise<void> { await this.#request(session, browserHumanInput(input)); }
  async stream(session: string): Promise<string> {
    const data = await this.#request(session, { action: 'stream_status' }) as { enabled?: boolean; port?: number };
    if (!data?.enabled || !Number.isInteger(data.port) || data.port! < 1 || data.port! > 65535) throw Error('Invalid browser stream status');
    // Pin the stream to this randomly named daemon, rather than trusting a reusable TCP port.
    await new Promise<void>((resolve, reject) => {
      const request = get({ hostname: '127.0.0.1', port: data.port, path: '/api/sessions', timeout: 3000 }, response => {
        if (response.statusCode !== 200) { response.destroy(); reject(Error('Browser stream identity unavailable')); return; }
        let text = ''; let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) response.destroy(Error('Browser stream identity too large')); else text += chunk.toString('utf8'); });
        response.on('error', () => reject(Error('Browser stream identity interrupted')));
        response.on('end', () => { try { const entries: unknown = JSON.parse(text); if (!Array.isArray(entries) || !entries.some((entry: { session?: string; port?: number }) => entry?.session === session && entry.port === data.port)) throw Error(); resolve(); } catch { reject(Error('Browser stream identity changed')); } });
      });
      request.on('timeout', () => request.destroy(Error('Browser stream identity timed out')));
      request.on('error', () => reject(Error('Browser stream identity unavailable')));
    });
    const after = await this.#request(session, { action: 'stream_status' }) as { enabled?: boolean; port?: number };
    if (!after?.enabled || after.port !== data.port) throw Error('Browser stream generation changed');
    return `ws://127.0.0.1:${data.port}`;
  }
  async pauseStream(session: string): Promise<void> { await this.#request(session, { action: 'stream_disable' }); }
  async resumeStream(session: string): Promise<void> { await this.#request(session, { action: 'stream_enable', port: 0 }); await this.#request(session, { action: 'stream_status' }); }
  async close(session: string): Promise<void> {
    const h = this.#handles.get(session); if (!h) return;
    try { await this.#request(session, { action: 'close' }); } catch { /* Owned-process cleanup, not a transport reply, establishes closure. */ }
    await this.#stop(h.process, h.exited, h.owned); this.#handles.delete(session); await rm(h.directory, { recursive: true, force: true });
  }
  async dispose(): Promise<void> { await Promise.allSettled([...this.#handles.keys()].map(session => this.close(session))); }
}
