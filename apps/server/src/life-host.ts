import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { migrate, PostgresLives, LifeRegistryError, type MiraLife } from '@mira/persistence';
import { memoryUsage, resetMemoryWorkspace } from '@mira/workspace';
import { LocalWebService, type WebServiceOptions } from './web-service.ts';
import { WebHttpError, type WebBackend } from './http.ts';
import type { BrowserView, BrowserWebBackend } from './browser-http.ts';
import type { ExternalIngress } from './external-ingress.ts';
import type { ManagementBackend } from './management.ts';
import type { PersonaBackend } from './persona-http.ts';

export type ResetScope = 'memory' | 'life';
export type ResetState = 'stopping' | 'archiving' | 'starting' | 'completed' | 'failed';
export interface ResetPreview {
  scope: ResetScope;
  lifeId: string;
  persona: { name: string; custom: boolean };
  impact: { memoryFiles: number; memoryBytes: number; compactions: number; messages: number; pendingWakes: number; pendingDeliveries: number };
  busy: { running: boolean; subagents: number };
  token: string;
  expiresAt: string;
  /** Where a whole-life reset will move the old Memory repository; null for scope memory. */
  archivePath: string | null;
}
export interface ResetView { id: string; scope: ResetScope; state: ResetState; lifeId: string | null; archivePath: string | null; commit: string | null; error: string | null }
export interface ResetBackend {
  previewReset(scope: ResetScope): Promise<ResetPreview>;
  reset(input: { scope: ResetScope; token: string; stopRunning: boolean; resetPersona: boolean }): Promise<{ resetId: string }>;
  resetStatus(id: string): ResetView | null;
}
export type LifeBackend = WebBackend & ManagementBackend & PersonaBackend & ResetBackend;
/** Test-only fault injection: a SimulatedCrash leaves every durable artifact
 * exactly as a killed process would (no rollback, journal kept). */
export class SimulatedCrash extends Error { constructor(step: string) { super(`Simulated crash at ${step}`); this.name = 'SimulatedCrash'; } }
export type ResetStep = 'stopped' | 'journal-prepared' | 'switched' | 'archived' | 'cleared' | 'started' | 'finalized';
export interface LifeHostOptions {
  /** Stable slot of the one continuous Mira; generation 0 uses it as mira_id. */
  slot: string;
  miraHome: string;
  service: Omit<WebServiceOptions, 'miraId' | 'memoryRefreshFile'> & { memoryRoot: string };
  /** Token lifetime; production uses two minutes. */
  tokenTtlMs?: number;
  fault?: (step: ResetStep) => void | Promise<void>;
  now?: () => Date;
}
interface Journal {
  version: 1; resetId: string; scope: ResetScope | 'restore'; slot: string; lifeId: string; occurredAt: string;
  step: 'prepared' | 'switched' | 'archived' | 'cleared' | 'archived-current';
  resetPersona: boolean; personaRevision: string | null; archivePath: string | null;
  to?: string; commit?: string; targetArchivePath?: string | null;
}
interface Token { scope: ResetScope; lifeId: string; personaRevision: string; expiresAt: number; archivePath: string | null }
const TOKEN_TTL_MS = 120_000;
const RESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errno = (error: unknown, code: string) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
async function exists(location: string): Promise<boolean> {
  try { await lstat(location); return true; } catch (error) { if (errno(error, 'ENOENT')) return false; throw error; }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  await syncDirectory(path.dirname(file));
}
async function removeDurably(file: string): Promise<void> {
  try { await unlink(file); } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
  await syncDirectory(path.dirname(file));
}
/** Idempotent move of one directory: never overwrites, never guesses. */
async function moveOnce(source: string, target: string): Promise<void> {
  const [from, to] = await Promise.all([exists(source), exists(target)]);
  if (from && to) throw new Error(`Both ${source} and ${target} exist; refusing to merge or overwrite`);
  if (!from) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await rename(source, target);
  await syncDirectory(path.dirname(source)); await syncDirectory(path.dirname(target));
}
export const resetJournalFile = (miraHome: string) => path.join(miraHome, 'reset-journal.json');
export const memoryRefreshFile = (miraHome: string) => path.join(miraHome, 'memory-refresh.json');
async function readJournal(miraHome: string): Promise<Journal | null> {
  let text: string;
  try { text = await readFile(resetJournalFile(miraHome), 'utf8'); } catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
  const value = JSON.parse(text) as Journal;
  if (value?.version !== 1 || !RESET_ID.test(value.resetId) || !['memory', 'life', 'restore'].includes(value.scope)) throw new Error('The reset journal is damaged; inspect it before starting Mira');
  return value;
}
function archiveName(lifeId: string, at: Date): string {
  const stamp = at.toISOString().replace(/:(\d\d)\.\d{3}Z$/, '$1Z').replace(/:/g, '');
  return `${lifeId.replace(/~/g, '-')}-${stamp}`;
}

/** Owns which life the local service runs (ADR 0047): preflight, confirmed
 * reset A (clear Memory as a Git commit) or B (start a new life), a crash-safe
 * journal and the in-process restart. HTTP always sees one stable backend. */
export class MiraLifeHost {
  readonly backend: LifeBackend;
  readonly external: ExternalIngress;
  readonly browser: BrowserWebBackend;
  readonly lives: PostgresLives;
  readonly #options: LifeHostOptions;
  #service: LocalWebService | undefined;
  #lifeId: string;
  #active: { id: string; record: ResetView } | undefined;
  #failure: string | null = null;
  #closed = false;
  readonly #tokens = new Map<string, Token>();
  readonly #records = new Map<string, ResetView>();
  readonly #browserListeners = new Set<(browser: BrowserView) => void>();
  #browserUnsubscribe: (() => void) | undefined;

  private constructor(options: LifeHostOptions, lives: PostgresLives, lifeId: string) {
    this.#options = options; this.lives = lives; this.#lifeId = lifeId;
    const current = (): LocalWebService => {
      if (!this.#service || this.#active || this.#closed) throw new WebHttpError('unavailable');
      return this.#service;
    };
    const methods = new Set(Object.getOwnPropertyNames(LocalWebService.prototype)
      .filter(name => name !== 'constructor' && name !== 'status' && name !== 'close' && typeof Object.getOwnPropertyDescriptor(LocalWebService.prototype, name)?.value === 'function'));
    const own: Record<string, unknown> = {
      status: () => this.status(),
      previewReset: (scope: ResetScope) => this.previewReset(scope),
      reset: (input: Parameters<ResetBackend['reset']>[0]) => this.reset(input),
      resetStatus: (id: string) => this.resetStatus(id),
    };
    this.browser = {
      list: () => this.#service && !this.#active ? this.#service.browser.list() : [],
      takeover: id => current().browser.takeover(id),
      release: (id, epoch) => current().browser.release(id, epoch),
      reopen: (id, epoch) => current().browser.reopen(id, epoch),
      disconnect: (id, epoch) => { this.#service?.browser.disconnect(id, epoch); },
      stream: id => current().browser.stream(id),
      invalidate: id => { this.#service?.browser.invalidate(id); },
      humanInput: (id, epoch, input, live) => current().browser.humanInput(id, epoch, input, live),
      humanNavigate: (id, epoch, action) => current().browser.humanNavigate(id, epoch, action),
      isHuman: (id, epoch) => !!this.#service && !this.#active && this.#service.browser.isHuman(id, epoch),
      subscribe: listener => { this.#browserListeners.add(listener); return () => { this.#browserListeners.delete(listener); }; },
    };
    own['browser'] = this.browser;
    this.backend = new Proxy({}, {
      get: (_target, key) => {
        if (typeof key !== 'string') return undefined;
        if (Object.hasOwn(own, key)) return own[key];
        if (methods.has(key)) return (...args: unknown[]) => (current() as unknown as Record<string, (...values: unknown[]) => unknown>)[key]!(...args);
        return undefined;
      },
      has: (_target, key) => typeof key === 'string' && (Object.hasOwn(own, key) || methods.has(key)),
    }) as LifeBackend;
    this.external = {
      emitEvent: (sender, event) => current().external.emitEvent(sender, event),
      requestWake: (sender, wake) => current().external.requestWake(sender, wake),
      sendNotification: (sender, notification) => current().external.sendNotification(sender, notification),
    };
  }
  /** Migrate, finish or roll back any journaled reset, then open the active life. */
  static async open(options: LifeHostOptions): Promise<MiraLifeHost> {
    if (!path.isAbsolute(options.miraHome)) throw new Error('MIRA_HOME must be absolute');
    await migrate({ connectionString: options.service.connectionString, schema: options.service.schema, direction: 'up' });
    const lives = new PostgresLives({ connectionString: options.service.connectionString, schema: options.service.schema });
    const host = new MiraLifeHost(options, lives, (await lives.active(options.slot)).miraId);
    const journal = await readJournal(options.miraHome);
    let finalize: Journal | null = null;
    if (journal) {
      const record: ResetView = { id: journal.resetId, scope: journal.scope === 'restore' ? 'life' : journal.scope, state: 'archiving', lifeId: null, archivePath: journal.archivePath, commit: journal.commit ?? null, error: null };
      host.#records.set(journal.resetId, record);
      const forward = await host.#forward(journal, record, true);
      if (forward) { host.#lifeId = forward; finalize = journal; }
      else { record.state = 'failed'; record.error = 'The reset was interrupted before anything changed; nothing was reset.'; }
    }
    await host.#start();
    if (finalize) {
      const record = host.#records.get(finalize.resetId)!;
      await host.#finalize(finalize, record);
      record.state = 'completed'; record.lifeId = host.#lifeId;
    }
    return host;
  }
  get lifeId(): string { return this.#lifeId; }
  /** The running service; undefined while a reset is switching lives. */
  get service(): LocalWebService | undefined { return this.#service; }
  async #start(): Promise<void> {
    const service = await LocalWebService.open({ ...this.#options.service, miraId: this.#lifeId, memoryRefreshFile: memoryRefreshFile(this.#options.miraHome), miraHome: this.#options.miraHome });
    this.#browserUnsubscribe?.();
    this.#browserUnsubscribe = service.browser.subscribe(browser => { for (const listener of this.#browserListeners) listener(browser); });
    this.#service = service;
  }
  async #stop(): Promise<void> {
    const service = this.#service; this.#service = undefined;
    this.#browserUnsubscribe?.(); this.#browserUnsubscribe = undefined;
    // close() fences and cancels the current Wake, children, terminals and
    // browser sessions; unknown effects are recorded as interrupted, never replayed.
    if (service) await service.close().catch(() => undefined);
  }
  async status(): Promise<Awaited<ReturnType<WebBackend['status']>>> {
    const reset = this.#active ? { reset: { id: this.#active.id, state: this.#active.record.state as string } } : {};
    if (this.#service && !this.#active) return { ...await this.#service.status(), lifeId: this.#lifeId };
    return { state: 'stopped', mode: this.#options.service.synthetic ? 'synthetic' : 'live', model: null, error: this.#failure, errorId: this.#failure ? 'reset-failed' : null, lifeId: this.#lifeId, ...reset };
  }
  #archivePath(): string {
    return path.join(this.#options.miraHome, 'archive', archiveName(this.#lifeId, this.#options.now?.() ?? new Date()));
  }
  async previewReset(scope: ResetScope): Promise<ResetPreview> {
    if (scope !== 'memory' && scope !== 'life') throw new WebHttpError('invalid_input');
    if (this.#active) throw new WebHttpError('busy');
    const service = this.#service;
    if (!service || this.#closed) throw new WebHttpError('unavailable');
    const persona = await service.persona().catch(() => ({ revision: '', persona: null }));
    const usage = await memoryUsage({ memoryRoot: this.#options.service.memoryRoot }).catch(() => ({ files: 0, bytes: 0 }));
    const counts = await this.lives.impact(this.#lifeId);
    const activity = service.activity();
    const now = Date.now();
    for (const [key, value] of this.#tokens) if (value.expiresAt <= now) this.#tokens.delete(key);
    const token = randomBytes(32).toString('base64url');
    const ttl = this.#options.tokenTtlMs ?? TOKEN_TTL_MS;
    const archivePath = scope === 'life' ? this.#archivePath() : null;
    this.#tokens.set(token, { scope, lifeId: this.#lifeId, personaRevision: persona.revision, expiresAt: now + ttl, archivePath });
    return { scope, lifeId: this.#lifeId, persona: { name: persona.persona?.name ?? 'Mira', custom: persona.persona !== null },
      impact: { memoryFiles: usage.files, memoryBytes: usage.bytes, compactions: counts.compactions, messages: counts.messages, pendingWakes: counts.pendingWakes, pendingDeliveries: counts.pendingDeliveries },
      busy: { running: activity.running || counts.runningWake, subagents: activity.subagents }, token, expiresAt: new Date(now + ttl).toISOString(), archivePath };
  }
  async reset(input: { scope: ResetScope; token: string; stopRunning: boolean; resetPersona: boolean }): Promise<{ resetId: string }> {
    if (this.#active) throw new WebHttpError('busy');
    const service = this.#service;
    if (!service || this.#closed) throw new WebHttpError('unavailable');
    const token = this.#tokens.get(input.token);
    if (!token || token.expiresAt <= Date.now() || token.scope !== input.scope || token.lifeId !== this.#lifeId) { this.#tokens.delete(input.token); throw new WebHttpError('conflict'); }
    const persona = await service.persona().catch(() => ({ revision: '', persona: null }));
    if (input.resetPersona && persona.revision !== token.personaRevision) throw new WebHttpError('conflict');
    const activity = service.activity();
    if ((activity.running || activity.subagents > 0) && !input.stopRunning) throw new WebHttpError('busy');
    this.#tokens.delete(input.token);
    const resetId = randomUUID();
    const journal: Journal = { version: 1, resetId, scope: input.scope, slot: this.#options.slot, lifeId: this.#lifeId, occurredAt: (this.#options.now?.() ?? new Date()).toISOString(),
      step: 'prepared', resetPersona: input.resetPersona && persona.persona !== null, personaRevision: persona.revision, archivePath: token.archivePath };
    const record: ResetView = { id: resetId, scope: input.scope, state: 'stopping', lifeId: null, archivePath: token.archivePath, commit: null, error: null };
    this.#records.set(resetId, record);
    this.#active = { id: resetId, record };
    // Journal before stopping anything, so a crash at any later point resumes.
    await writeAtomic(resetJournalFile(this.#options.miraHome), journal);
    void this.#run(journal, record);
    return { resetId };
  }
  resetStatus(id: string): ResetView | null { const record = this.#records.get(id); return record ? { ...record } : null; }
  async #fault(step: ResetStep): Promise<void> { await this.#options.fault?.(step); }
  async #run(journal: Journal, record: ResetView): Promise<void> {
    try {
      await this.#fault('journal-prepared');
      await this.#stop();
      await this.#fault('stopped');
      record.state = 'archiving';
      const lifeId = await this.#forward(journal, record, false);
      if (!lifeId) throw new Error('Reset journal disappeared');
      this.#lifeId = lifeId;
      record.state = 'starting';
      await this.#start();
      await this.#fault('started');
      await this.#finalize(journal, record);
      record.state = 'completed'; record.lifeId = this.#lifeId; this.#failure = null;
    } catch (error) {
      record.state = 'failed';
      if (error instanceof SimulatedCrash) { record.error = error.message; this.#crashed = true; await this.#stop(); return; }
      const current = await readJournal(this.#options.miraHome).catch(() => null);
      if (current?.resetId === journal.resetId && current.step === 'prepared' && journal.scope === 'life' && !await this.lives.byReset(journal.resetId).catch(() => null)) {
        // Nothing durable changed: roll back and resume the same life.
        await removeDurably(resetJournalFile(this.#options.miraHome)).catch(() => undefined);
        record.error = 'The reset failed before switching; nothing was reset.';
        if (!this.#service) await this.#start().catch(() => { this.#failure = 'Mira could not restart after a failed reset. Restart the local server.'; });
      } else {
        record.error = 'The reset did not finish. Restart the local server to resume it from the journal.';
        this.#failure = record.error;
        await this.#stop();
      }
    } finally {
      if (this.#active?.id === journal.resetId) this.#active = undefined;
    }
  }
  /** Test hook state: a simulated crash leaves the host down like a killed process. */
  #crashed = false;
  get crashed(): boolean { return this.#crashed; }
  /** Advance durable steps until only service-level finalization remains.
   * Returns the life to open, or null after rolling back an unstarted reset. */
  async #forward(journal: Journal, record: ResetView, recovering: boolean): Promise<string | null> {
    const home = this.#options.miraHome; const memoryRoot = this.#options.service.memoryRoot; const spool = this.#options.service.spoolDirectory;
    const save = async (step: Journal['step'], extra: Partial<Journal> = {}) => { Object.assign(journal, extra, { step }); await writeAtomic(resetJournalFile(home), journal); };
    if (journal.scope === 'memory') {
      if (journal.step === 'prepared') {
        const result = await resetMemoryWorkspace({ memoryRoot, resetId: journal.resetId });
        await this.#fault('cleared');
        await save('cleared', { commit: result.commitId });
      }
      record.commit = journal.commit ?? null;
      // The next Wake re-reads Memory into its frozen snapshot once (ADR 0016 path).
      await writeAtomic(memoryRefreshFile(home), { version: 1, lifeId: journal.lifeId, resetId: journal.resetId });
      return journal.lifeId;
    }
    if (journal.scope === 'life') {
      if (journal.step === 'prepared') {
        const prior = await this.lives.byReset(journal.resetId);
        if (!prior) {
          if (recovering) {
            // Recovery: nothing switched yet, so roll back by forgetting the journal.
            await removeDurably(resetJournalFile(home)); return null;
          }
          const switched = await this.lives.startNewLife({ slot: journal.slot, from: journal.lifeId, resetId: journal.resetId, archivePath: journal.archivePath!, reason: 'reset' });
          await this.#fault('switched');
          await save('switched', { to: switched.to });
        } else await save('switched', { to: prior.miraId });
      }
      if (journal.step === 'switched') {
        const archive = journal.archivePath!;
        await mkdir(archive, { recursive: true, mode: 0o700 });
        await moveOnce(memoryRoot, path.join(archive, 'memory'));
        await moveOnce(spool, path.join(archive, 'wake-input'));
        await writeAtomic(path.join(archive, 'life.json'), { version: 1, lifeId: journal.lifeId, slot: journal.slot, resetId: journal.resetId, archivedAt: journal.occurredAt, nextLifeId: journal.to });
        await this.#fault('archived');
        await save('archived');
      }
      record.archivePath = journal.archivePath;
      return journal.to!;
    }
    // CLI restore: the DB already switched in restoreLife, files follow.
    if (journal.step === 'prepared') {
      const active = await this.lives.active(journal.slot);
      if (active.miraId !== journal.to) { await removeDurably(resetJournalFile(home)); return null; }
      await save('switched');
    }
    if (journal.step === 'switched') {
      await mkdir(journal.archivePath!, { recursive: true, mode: 0o700 });
      await moveOnce(memoryRoot, path.join(journal.archivePath!, 'memory'));
      await moveOnce(spool, path.join(journal.archivePath!, 'wake-input'));
      await writeAtomic(path.join(journal.archivePath!, 'life.json'), { version: 1, lifeId: journal.lifeId, slot: journal.slot, resetId: journal.resetId, archivedAt: journal.occurredAt, nextLifeId: journal.to });
      await save('archived-current');
    }
    if (journal.step === 'archived-current' && journal.targetArchivePath) {
      await moveOnce(path.join(journal.targetArchivePath, 'memory'), memoryRoot);
      await moveOnce(path.join(journal.targetArchivePath, 'wake-input'), spool);
    }
    return journal.to!;
  }
  /** Service-level, idempotent steps after the (new) life is open. */
  async #finalize(journal: Journal, record: ResetView): Promise<void> {
    const service = this.#service!;
    if (journal.scope === 'memory' && journal.commit) await service.recordMemoryReset({ resetId: journal.resetId, commit: journal.commit, occurredAt: journal.occurredAt });
    if (journal.resetPersona) {
      const persona = await service.persona();
      // Only the revision the user confirmed; a later edit wins over the reset.
      if (persona.revision === journal.personaRevision && persona.persona !== null) await service.savePersona(persona.revision, null);
    }
    await this.#fault('finalized');
    await removeDurably(resetJournalFile(this.#options.miraHome));
    record.lifeId = this.#lifeId;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#stop();
  }
}

/** CLI restore of an archived life (D11: no Web list). Mira must be stopped. */
export async function restoreArchivedLife(options: { connectionString: string; schema: string; slot: string; miraHome: string; memoryRoot: string; spoolDirectory: string; target: string; now?: Date }): Promise<{ from: string; to: string; archivePath: string }> {
  if (await readJournal(options.miraHome)) throw new Error('A reset is still journaled; start Mira once to finish it before restoring');
  await migrate({ connectionString: options.connectionString, schema: options.schema, direction: 'up' });
  const lives = new PostgresLives({ connectionString: options.connectionString, schema: options.schema });
  const current = await lives.active(options.slot);
  const archivePath = path.join(options.miraHome, 'archive', archiveName(current.miraId, options.now ?? new Date()));
  const resetId = randomUUID();
  const journal: Journal = { version: 1, resetId, scope: 'restore', slot: options.slot, lifeId: current.miraId, occurredAt: (options.now ?? new Date()).toISOString(),
    step: 'prepared', resetPersona: false, personaRevision: null, archivePath, to: options.target };
  await writeAtomic(resetJournalFile(options.miraHome), journal);
  let switched: Awaited<ReturnType<PostgresLives['restoreLife']>>;
  try { switched = await lives.restoreLife({ slot: options.slot, target: options.target, archivePath }); }
  catch (error) { await removeDurably(resetJournalFile(options.miraHome)); throw error; }
  Object.assign(journal, { step: 'switched', targetArchivePath: switched.targetArchivePath });
  await writeAtomic(resetJournalFile(options.miraHome), journal);
  await mkdir(archivePath, { recursive: true, mode: 0o700 });
  await moveOnce(options.memoryRoot, path.join(archivePath, 'memory'));
  await moveOnce(options.spoolDirectory, path.join(archivePath, 'wake-input'));
  await writeAtomic(path.join(archivePath, 'life.json'), { version: 1, lifeId: current.miraId, slot: options.slot, resetId, archivedAt: journal.occurredAt, nextLifeId: options.target });
  journal.step = 'archived-current'; await writeAtomic(resetJournalFile(options.miraHome), journal);
  if (switched.targetArchivePath) {
    await moveOnce(path.join(switched.targetArchivePath, 'memory'), options.memoryRoot);
    await moveOnce(path.join(switched.targetArchivePath, 'wake-input'), options.spoolDirectory);
  }
  await removeDurably(resetJournalFile(options.miraHome));
  return { from: current.miraId, to: options.target, archivePath };
}
export type { MiraLife };
export { LifeRegistryError };
