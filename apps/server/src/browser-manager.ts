import { randomUUID } from 'node:crypto';
import { AgentBrowserDriver, validateBrowserCommand, browserHumanInput, type BrowserDriver } from './browser-driver.ts';

export class BrowserControlError extends Error {
  readonly code?: 'browser_locked';
  constructor(message: string, code?: 'browser_locked') {
    super(message);
    this.name = 'BrowserControlError';
    if (code) this.code = code;
  }
}
export type BrowserState = 'agent' | 'requesting' | 'human' | 'held' | 'returning' | 'unknown' | 'closed';
export interface BrowserStatus { id: string; state: BrowserState; epoch: number; observation: number; ownerLabel: string; pressedButtons?: string[]; queuedInputs?: number; cancelledInputs?: number; domain?: string; userActivity?: { navigations: number; tabSwitches: number; domain?: string }; message?: string; lock?: 'outcome' | 'cleanup'; replacedBy?: string; replaces?: string }
export interface BrowserReleaseStatus extends BrowserStatus { cancelledInputs: number }
export interface BrowserResult extends BrowserStatus { output: unknown }
interface Session { id: string; owner: string; session: string; state: BrowserState; epoch: number; observation: number; observed: boolean; lock: Promise<void>; domain?: string; url?: string; replacedBy?: string; replaces?: string; cleanupUnknown?: boolean; finishedClose?: boolean; inputEpoch?: number; pressedButtons: Set<string>; pendingInputs: number; inFlightInput?: boolean; cancelledInputs?: number; userActivity?: { navigations: number; tabSwitches: number; domain?: string } }
/** Service-local coordination, not an OS security boundary. No command, input, frame, or reopen-address persistence. */
export class BrowserManager {
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<(status: BrowserStatus) => void>();
  readonly #driver: BrowserDriver;
  readonly #mainOwner: string;
  #closed = false;
  constructor(options: { driver?: BrowserDriver; cwd?: string; miraHome?: string; mainOwner?: string } = {}) { this.#mainOwner = options.mainOwner ?? 'main'; this.#driver = options.driver ?? new AgentBrowserDriver({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.miraHome === undefined ? {} : { miraHome: options.miraHome }) });
    this.#driver.onExit?.(session => { const s = [...this.#sessions.values()].find(s => s.session === session); if (s) this.#unknown(s); });
  }
  #status(s: Session): BrowserStatus { const message = s.state === 'unknown' ? (s.cleanupUnknown ? 'Browser cleanup could not be verified. Agent and human control remain disabled; closing may be retried.' : 'Browser outcome unknown. Do not replay commands. Close this browser and explicitly open a new one.') : s.state === 'closed' && s.replacedBy ? 'Closed and reopened by the user after an indeterminate outcome. The previous page, its state and element references are gone; use browser ' + s.replacedBy + ' after a fresh snapshot.' : s.state === 'agent' && s.userActivity ? 'While under user control the user navigated ' + s.userActivity.navigations + ' time(s) and switched tabs ' + s.userActivity.tabSwitches + ' time(s)' + (s.userActivity.domain ? ' (last site: ' + s.userActivity.domain + ')' : '') + '. The current page and tabs may differ from your last observation; take a fresh snapshot before acting.' : s.state === 'agent' && s.replaces && s.observation === 0 ? 'Opened fresh by the user to replace browser ' + s.replaces + ' (same address, new page; nothing carried over). Take a fresh snapshot before acting.' : undefined; return { id: s.id, state: s.state, epoch: s.epoch, observation: s.observation, pressedButtons: [...s.pressedButtons], queuedInputs: Math.max(0, s.pendingInputs - (s.inFlightInput ? 1 : 0)), ...(s.cancelledInputs !== undefined ? { cancelledInputs: s.cancelledInputs } : {}), ownerLabel: s.owner === this.#mainOwner ? 'Mira' : 'Task', ...(s.domain ? { domain: s.domain } : {}), ...(s.userActivity ? { userActivity: { navigations: s.userActivity.navigations, tabSwitches: s.userActivity.tabSwitches, ...(s.userActivity.domain ? { domain: s.userActivity.domain } : {}) } } : {}), ...(message ? { message } : {}), ...(s.state === 'unknown' ? { lock: s.cleanupUnknown ? 'cleanup' as const : 'outcome' as const } : {}), ...(s.replacedBy ? { replacedBy: s.replacedBy } : {}), ...(s.replaces ? { replaces: s.replaces } : {}) }; }
  #notify(s: Session): void { for (const listener of this.#listeners) { try { listener(this.#status(s)); } catch { /* Observers cannot break the control gate. */ } } }
  subscribe(listener: (status: BrowserStatus) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  list(): BrowserStatus[] { return [...this.#sessions.values()].map(s => this.#status(s)); }
  #get(id: string, owner?: string): Session { const s = this.#sessions.get(id); if (!s || (owner !== undefined && s.owner !== owner)) throw new BrowserControlError('No managed browser belongs to this stream; handles do not survive service restart.'); return s; }
  async #serial<T>(s: Session, work: () => Promise<T>): Promise<T> { const previous = s.lock; let release!: () => void; s.lock = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
  #unknown(s: Session): void { if (s.state !== 'closed' && s.state !== 'unknown') { s.state = 'unknown'; s.epoch++; s.observed = false; this.#notify(s); } }
  bind(owner: string) {
    if (!owner) throw new BrowserControlError('Browser owner is required');
    return {
      open: (url: string) => this.#open(owner, url),
      command: (id: string, args: string[], observation?: number) => this.#command(owner, id, args, observation),
      list: () => [...this.#sessions.values()].filter(s => s.owner === owner).map(s => this.#status(s)),
      close: async (id: string) => { const s = this.#get(id, owner); if (!['agent', 'unknown', 'closed'].includes(s.state)) throw new BrowserControlError('Browser is under human control; return it before closing'); await this.#close(s); },
    };
  }
  async #open(owner: string, url: string, replaces?: string): Promise<BrowserResult> {
    try { validateBrowserCommand(['open', url]); } catch { throw new BrowserControlError('Invalid browser URL'); }
    if (this.#closed) throw new BrowserControlError('Browser manager is closed');
    // Retain a bounded set of completed tombstones; never evict live/closing owners.
    for (const [id, previous] of this.#sessions) { if (this.#sessions.size < 64) break; if (previous.finishedClose) this.#sessions.delete(id); }
    if (this.#sessions.size >= 64 || [...this.#sessions.values()].filter(s => !s.finishedClose).length >= 8) throw new BrowserControlError('Managed browser capacity reached');
    const s: Session = { id: randomUUID(), owner, session: randomUUID(), state: 'agent', epoch: 0, observation: 0, observed: false, pressedButtons: new Set(), pendingInputs: 0, lock: Promise.resolve(), domain: new URL(url).hostname, ...(replaces ? { replaces } : {}) };
    this.#sessions.set(s.id, s);
    const previous = replaces ? this.#sessions.get(replaces) : undefined;
    if (previous) previous.replacedBy = s.id;
    return this.#serial(s, async () => { try { const output = await this.#driver.open(s.session, url); s.url = url; this.#notify(s); if (previous) this.#notify(previous); return { ...this.#status(s), output }; } catch { this.#unknown(s); if (previous) this.#notify(previous); throw Error('Browser could not be opened; outcome unknown. Check that agent-browser 0.39.1 and its browser are installed. Nothing was retried.'); } });
  }
  async #command(owner: string, id: string, args: string[], observation?: number): Promise<BrowserResult> {
    try { validateBrowserCommand(args); } catch { throw new BrowserControlError('Invalid or unsupported managed browser command'); }
    const s = this.#get(id, owner);
    const replaced = 'This browser was closed and reopened by the user; use browser_list to find its replacement and take a fresh snapshot';
    if (s.state !== 'agent') throw new BrowserControlError(s.state === 'closed' && s.replacedBy ? replaced : 'Browser is not under agent control');
    return this.#serial(s, async () => {
      if (s.state !== 'agent') throw new BrowserControlError(s.state === 'closed' && s.replacedBy ? replaced : 'Browser control changed before this command started; command was not run');
      if (args[0] !== 'snapshot' && (!s.observed || observation !== s.observation)) throw new BrowserControlError('Fresh browser snapshot required; prior observations and element references are stale');
      try {
        const output = await this.#driver.command(s.session, args);
        s.observation++; s.observed = args[0] === 'snapshot';
        if (args[0] === 'snapshot') delete s.userActivity;
        if (args[0] === 'open') { s.url = args[1]!; s.domain = new URL(args[1]!).hostname; }
        this.#notify(s); return { ...this.#status(s), output };
      } catch { this.#unknown(s); throw Error('Browser command failed or its outcome is unknown. It was not replayed; inspect the browser before closing it.'); }
    });
  }
  async takeover(id: string): Promise<BrowserStatus> {
    const s = this.#get(id);
    if (s.state === 'unknown') throw new BrowserControlError(s.cleanupUnknown ? 'Browser close could not be confirmed; close and reopen it before taking over' : 'Browser is locked after an unconfirmed outcome; close and reopen it before taking over', 'browser_locked');
    if (!['agent', 'held'].includes(s.state)) throw new BrowserControlError('Browser cannot be taken over in its current state');
    delete s.cancelledInputs;
    s.state = 'requesting'; s.epoch++; s.observation++; s.observed = false; this.#notify(s);
    return this.#serial(s, async () => {
      if (s.state !== 'requesting') throw new BrowserControlError('Browser takeover interrupted');
      { try { await this.#driver.pauseStream(s.session); await this.#driver.resumeStream(s.session); } catch { this.#unknown(s); throw Error('Browser frame stream could not be refreshed; control remains disabled'); } }
      if (s.state !== 'requesting') throw new BrowserControlError('Browser takeover interrupted');
      s.state = 'human'; s.inputEpoch = s.epoch; this.#notify(s); return this.#status(s);
    });
  }
  invalidate(id: string): void { const s = this.#sessions.get(id); if (s) this.#unknown(s); }
  isHuman(id: string, epoch: number): boolean { const s = this.#sessions.get(id); return s?.state === 'human' && s.epoch === epoch; }
  async humanInput(id: string, epoch: number, input: Record<string, unknown>, current?: () => boolean): Promise<void> {
    let command: Record<string, unknown>;
    try { command = browserHumanInput(input); } catch { throw new BrowserControlError('Invalid human browser input'); }
    const s = this.#get(id);
    if (!this.isHuman(id, epoch)) throw new BrowserControlError('Stale browser input lease');
    if (s.pendingInputs >= 128) { this.#unknown(s); throw new BrowserControlError('Human browser input queue exceeded its limit; control disabled'); }
    s.pendingInputs++;
    try { await this.#serial(s, async () => {
      if (s.inputEpoch !== epoch || ['unknown', 'closed', 'agent'].includes(s.state) || (current && !current())) return; // Unissued cancellation has no unknown side effect.
      s.inFlightInput = true;
      try { await this.#driver.humanInput(s.session, command);
        if (command.action === 'input_mouse' && typeof command.button === 'string' && command.button !== 'none') {
          if (command.type === 'mousePressed') s.pressedButtons.add(command.button);
          if (command.type === 'mouseReleased') s.pressedButtons.delete(command.button);
          this.#notify(s);
        }
      }
      catch { this.#unknown(s); throw Error('Human browser input outcome unknown; it was not replayed'); }
      finally { s.inFlightInput = false; }
    }); } finally { s.pendingInputs--; }
  }
  async humanNavigate(id: string, epoch: number, action: { kind: 'open'; url: string } | { kind: 'tab'; tabId: string }): Promise<BrowserStatus> {
    const s = this.#get(id);
    if (!this.isHuman(id, epoch)) throw new BrowserControlError('Browser navigation requires the current human control lease');
    if (action.kind === 'open') {
      if (typeof action.url !== 'string' || action.url.length > 2048) throw new BrowserControlError('Only http(s) addresses without credentials can be opened');
      try { validateBrowserCommand(['open', action.url]); } catch { throw new BrowserControlError('Only http(s) addresses without credentials can be opened'); }
    } else if (typeof action.tabId !== 'string' || !/^[\w-]{1,128}$/.test(action.tabId)) throw new BrowserControlError('Invalid tab id');
    return this.#serial(s, async () => {
      if (s.inputEpoch !== epoch || s.state !== 'human') throw new BrowserControlError('Browser control changed before navigation started; it was not run');
      try { await this.#driver.command(s.session, action.kind === 'open' ? ['open', action.url] : ['tab', action.tabId]); }
      catch { this.#unknown(s); throw Error('Browser navigation outcome unknown; it was not replayed'); }
      const prior = s.userActivity;
      if (action.kind === 'open') {
        const host = new URL(action.url).hostname;
        s.url = action.url; s.domain = host;
        s.userActivity = { navigations: (prior?.navigations ?? 0) + 1, tabSwitches: prior?.tabSwitches ?? 0, ...(host ? { domain: host } : {}) };
      } else s.userActivity = { navigations: prior?.navigations ?? 0, tabSwitches: (prior?.tabSwitches ?? 0) + 1, ...(prior?.domain ? { domain: prior.domain } : {}) };
      this.#notify(s); return this.#status(s);
    });
  }
  disconnect(id: string, epoch: number): void { const s = this.#get(id); if (!this.isHuman(id, epoch)) return; s.state = 'held'; s.epoch++; delete s.inputEpoch; this.#notify(s); }
  async stream(id: string): Promise<string> { const blocked = (s: Session) => s.state === 'closed' || s.state === 'returning' || (s.state === 'unknown' && !!s.cleanupUnknown); const s = this.#get(id); if (blocked(s)) throw new BrowserControlError('Browser stream unavailable'); return this.#serial(s, async () => { if (blocked(s)) throw new BrowserControlError('Browser stream unavailable'); try { return await this.#driver.stream(s.session); } catch { if (s.state !== 'unknown') this.#unknown(s); throw Error('Browser stream unavailable; browser outcome unknown'); } }); }
  async release(id: string, epoch: number): Promise<BrowserReleaseStatus> {
    const s = this.#get(id);
    if (!['human', 'held'].includes(s.state) || s.epoch !== epoch) throw new BrowserControlError('Stale browser control lease');
    const cancelledInputs = Math.max(0, s.pendingInputs - (s.inFlightInput ? 1 : 0));
    s.cancelledInputs = cancelledInputs;
    delete s.inputEpoch;
    s.state = 'returning'; s.epoch++; s.observation++; s.observed = false; this.#notify(s);
    return this.#serial(s, async () => {
      try {
        // Unissued input was revoked synchronously; any already-issued daemon input has settled on this queue.
        if (s.state !== 'returning') throw Error('Browser return interrupted');
        if (s.pressedButtons.size) { s.state = 'held'; this.#notify(s); return { ...this.#status(s), cancelledInputs }; }
        // Reset streaming only to discard cached frames, never as an input-drain barrier.
        await this.#driver.pauseStream(s.session);
        await this.#driver.command(s.session, ['snapshot', '-i']);
        await this.#driver.resumeStream(s.session);
        if (s.state !== 'returning') throw Error('Browser return interrupted');
        s.state = 'agent'; this.#notify(s); return { ...this.#status(s), cancelledInputs };
      } catch { this.#unknown(s); throw Error('Browser return could not be verified; agent control remains disabled'); }
    });
  }
  async reopen(id: string, epoch: number): Promise<BrowserStatus> {
    const s = this.#get(id);
    if (s.state !== 'unknown' || s.epoch !== epoch) throw new BrowserControlError('Browser is not locked in an indeterminate state or the view is stale; refresh and retry');
    if (!s.url) throw new BrowserControlError('No address is known for reopening this browser');
    const url = s.url; const owner = s.owner;
    try { await this.#close(s); } catch { throw Error('Browser close could not be verified; the locked browser was not reopened'); }
    const opened = await this.#open(owner, url, s.id);
    return this.#status(this.#sessions.get(opened.id)!);
  }
  async #close(s: Session): Promise<void> { if (s.state === 'closed') return; s.state = 'closed'; s.epoch++; s.observed = false; this.#notify(s); await this.#serial(s, async () => { try { await this.#driver.close(s.session); s.finishedClose = true; } catch (error) { if (!this.#closed) { s.state = 'unknown'; s.cleanupUnknown = true; this.#notify(s); } throw error; } }); }
  /** Close the agent-controlled browsers whose owner is exactly `owner` (a
   * cancelled child's stream). A browser the user is holding stays open.
   * Other owners are never touched. Bounded wait per browser. */
  async closeOwner(owner: string, waitMs = 5_000): Promise<{ closed: number; kept: number }> {
    if (!owner || owner === this.#mainOwner) return { closed: 0, kept: 0 };
    const owned = [...this.#sessions.values()].filter(s => s.owner === owner && s.state !== 'closed');
    const closable = owned.filter(s => s.state === 'agent' || s.state === 'unknown');
    await Promise.all(closable.map(s => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, waitMs); timer.unref?.();
      void this.#close(s).catch(() => undefined).finally(() => { clearTimeout(timer); resolve(); });
    })));
    return { closed: closable.length, kept: owned.length - closable.length };
  }
  /** Drop finished-close tombstones of exactly this task owner (ADR 0052); never main's. */
  forgetOwner(owner: string): number {
    if (!owner || owner === this.#mainOwner) return 0;
    let dropped = 0;
    for (const [id, s] of this.#sessions) if (s.owner === owner && s.finishedClose && !s.replacedBy) { this.#sessions.delete(id); dropped++; }
    return dropped;
  }
  get retainedSessions(): number { return this.#sessions.size; }
  async close(): Promise<void> { this.#closed = true; await Promise.allSettled([...this.#sessions.values()].map(s => this.#close(s))); await this.#driver.dispose(); }
}
