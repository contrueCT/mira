import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

interface Identity { pid: number; ppid: number; pgid: number; start: string; state: string }
async function processes(): Promise<Identity[]> {
  const output = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(Error('Browser process identities unavailable')) : resolve(stdout)));
  const rows = output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4]!, start: match[5]! }] : [];
  });
  if (process.platform === 'linux') await Promise.all(rows.map(async row => {
    try { const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); row.start = fields[19] ?? ''; }
    catch { row.start = ''; } // Exited or unreadable processes are never guessed.
  }));
  return rows.filter(row => row.start && row.pid > 1);
}
const same = (a: Identity, b: Identity) => a.pid === b.pid && a.start === b.start;
/** Captures only descendants of this owned launch. No command lines, credentials, or global kills. */
export class BrowserProcesses {
  readonly #root: number;
  readonly #owned = new Map<number, Identity>();
  #cleanup: Promise<void> | undefined;
  #retired = false;
  #captureUncertain = false;
  #unobservableCommand = false;
  markUnobservableCommand(): void { this.#unobservableCommand = true; }
  retireRoot(): void { this.#retired = true; }
  constructor(root: number) { this.#root = root; }
  async capture(requireDescendant = false): Promise<void> {
    try { await this.#capture(requireDescendant); } catch (error) { this.#captureUncertain = true; throw error; }
  }
  async #capture(requireDescendant: boolean): Promise<void> {
    const rows = await processes();
    if (!this.#owned.size) { if (this.#retired) throw Error('Browser exited before process ownership could be captured'); const root = rows.find(row => row.pid === this.#root); if (!root) throw Error('Browser exited before process ownership could be captured'); this.#owned.set(root.pid, root); }
    const live = new Set(rows.filter(row => { const known = this.#owned.get(row.pid); return known && same(known, row); }).map(row => row.pid));
    for (let changed = true; changed;) { changed = false; for (const row of rows) if (live.has(row.ppid) && !live.has(row.pid)) { live.add(row.pid); this.#owned.set(row.pid, row); changed = true; } }
    if (requireDescendant && !rows.some(row => row.pid === this.#root && !row.state.startsWith('Z') && live.has(row.pid))) throw Error('Owned browser root exited before descendant capture');
    if (requireDescendant && !rows.some(row => row.pid !== this.#root && !row.state.startsWith('Z') && live.has(row.pid))) throw Error('Owned browser process identity could not be captured');
  }
  cleanup(): Promise<void> { return this.#cleanup ??= this.#clean().catch(error => { this.#cleanup = undefined; throw error; }); }
  async #clean(): Promise<void> {
    // A surviving captured Chrome group remains identifiable after its daemon dies.
    await this.capture();
    const rows = await processes();
    for (const known of [...this.#owned.values()].reverse()) {
      const current = rows.find(row => same(known, row)); if (!current) continue;
      try { process.kill(current.pid === current.pgid && current.pgid === known.pgid ? -current.pid : current.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw Error('Owned browser process cleanup could not be verified'); }
    }
    const deadline = Date.now() + 2000;
    while (true) {
      const remaining = (await processes()).some(row => !row.state.startsWith('Z') && [...this.#owned.values()].some(known => same(known, row)));
      if (!remaining) { if (this.#captureUncertain || this.#unobservableCommand) throw Error('Browser cleanup unknown because process ownership could not be captured'); return; }
      if (Date.now() >= deadline) throw Error('Owned browser process cleanup could not be verified');
      await delay(25);
    }
  }
}
