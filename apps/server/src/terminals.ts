import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { WriteOverflowInput } from '@mira/cognition';

export const terminalLimits = { concurrent: 16, retained: 128, yieldMs: 10_000, outputBytes: 8192, logBytes: 64 * 1024 * 1024 } as const;
type Chunk = { path: string; start: number; end: number; sha256: string };
type Status = 'running' | 'exited' | 'closed' | 'output_limit' | 'unknown';
interface Session {
  id: string; owner: string; callId: string | null; inputBytes: number; host: ChildProcess; status: Status; code: number | null;
  signal: string | number | null; chunks: Chunk[]; bytes: number; received: number;
  log: Promise<void>; lock: Promise<void>; failure: unknown; changes: Set<() => void>;
  done: Promise<void>; resolveDone: () => void; closing: boolean;
  requests: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
}
export interface TerminalExec { command: string; cwd?: string; shell?: string; tty?: boolean; yield_ms?: number; max_output_bytes?: number }
export interface TerminalWrite { session_id: string; offset: number; chars?: string; interrupt?: boolean; yield_ms?: number; max_output_bytes?: number }
export interface TerminalResult {
  session_id: string; status: Status | 'unavailable'; output: string; offset: number; next_offset: number;
  has_more: boolean; exit_code: number | null; signal: string | number | null;
  cleanup_scope?: string; log_index?: string; message?: string; input_bytes_remaining?: number;
}
class TerminalError extends Error {}
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Only live process handles are in memory. Durable tool intent/outcome remains the runtime's job. */
export class TerminalManager {
  readonly #sessions = new Map<string, Session>();
  readonly #writeFile: WriteOverflowInput;
  readonly #cwd: string;
  #closed = false;
  constructor(options: { cwd: string; writeOverflowInput: WriteOverflowInput }) { this.#cwd = options.cwd; this.#writeFile = options.writeOverflowInput; }
  #notify(session: Session): void { for (const notify of [...session.changes]) notify(); }
  #send(session: Session, message: unknown): void { if (session.host.connected) session.host.send(message as object, () => {}); }
  #request(session: Session, message: { type: string; text?: string }, signal?: AbortSignal): Promise<void> {
    if (!session.host.connected) return Promise.reject(Error('Terminal host disconnected before input acknowledgement'));
    return new Promise<void>((resolve, reject) => {
      const request = randomUUID();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); session.requests.delete(request); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const abort = () => fail(Error('Terminal input acknowledgement interrupted; its effect is unknown. Inspect the existing session before sending again.'));
      const timer = setTimeout(abort, 1000);
      session.requests.set(request, { resolve: () => { cleanup(); resolve(); }, reject: fail });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      session.host.send({ ...message, request }, error => { if (error) fail(error); });
    });
  }
  list(owner: string) {
    return [...this.#sessions.values()].filter(session => session.owner === owner).map(session => ({ session_id: session.id, launch_call_id: session.callId,
      status: session.status, bytes: session.bytes, exit_code: session.code, input_bytes_remaining: 1024 * 1024 - session.inputBytes }));
  }
  #lookup(owner: string, id: string): Session | undefined { const session = this.#sessions.get(id); return session?.owner === owner ? session : undefined; }
  #unavailable(id: string, offset: number): TerminalResult {
    return { session_id: id, status: 'unavailable', output: '', offset, next_offset: offset, has_more: false, exit_code: null, signal: null,
      message: 'No live session belongs to this stream. Sessions do not survive service restart; previous work is interrupted or unknown. Inspect saved tool outcomes/logs. Never automatically replay the command.' };
  }
  async #serial<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const previous = session.lock; let release!: () => void;
    session.lock = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await work(); } finally { release(); }
  }
  #options(yieldMs = 1000, maxBytes: number = terminalLimits.outputBytes): void {
    if (!integer(yieldMs, 0, terminalLimits.yieldMs) || !integer(maxBytes, 4, terminalLimits.outputBytes)) throw new TerminalError('Invalid terminal wait or output budget');
  }
  async exec(owner: string, args: TerminalExec, signal?: AbortSignal, callId?: string): Promise<TerminalResult> {
    this.#options(args.yield_ms, args.max_output_bytes);
    if (!args.command || args.command.length > 32_768 || args.command.includes('\0')) throw new TerminalError('Invalid terminal command');
    if (this.#closed) throw new TerminalError('Terminal manager is closed');
    signal?.throwIfAborted();
    if ([...this.#sessions.values()].filter(session => session.status === 'running' || session.closing).length >= terminalLimits.concurrent) throw new TerminalError('Terminal capacity reached; close an existing session first');
    // Never evict a live process. Old ended sessions remain readable until the bounded handle cache fills.
    if (this.#sessions.size >= terminalLimits.retained) {
      const ended = [...this.#sessions.values()].find(session => session.status !== 'running' && !session.closing);
      if (ended) this.#sessions.delete(ended.id); else throw new TerminalError('Terminal capacity reached');
    }
    const host = fork(new URL('./terminal-process.mts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    let resolveDone!: () => void;
    const session: Session = { id: randomUUID(), owner, callId: callId ?? null, inputBytes: 0, host, status: 'running', code: null, signal: null, chunks: [], bytes: 0, received: 0,
      log: Promise.resolve(), lock: Promise.resolve(), failure: null, changes: new Set(), done: new Promise<void>(resolve => { resolveDone = resolve; }), resolveDone: () => resolveDone(), closing: false, requests: new Map() };
    this.#sessions.set(session.id, session);
    host.on('message', (message: { type: string; text?: string; code?: number | null; signal?: string | number | null; error?: string; request?: string; inputBytes?: number }) => {
      if (message.type === 'accepted' || message.type === 'input_error' || message.type === 'input_rejected') {
        const request = session.requests.get(message.request ?? ''); session.requests.delete(message.request ?? '');
        if (message.type === 'accepted') { session.inputBytes = message.inputBytes ?? session.inputBytes; request?.resolve(); }
        else if (message.type === 'input_rejected') request?.reject(new TerminalError('Input was not accepted: terminal ended or its 1 MiB lifetime input budget was exhausted'));
        else request?.reject(Error('Terminal input was not acknowledged; its effect is unknown'));
      } else if (message.type === 'data' && typeof message.text === 'string') {
        const text = message.text;
        session.received += Buffer.byteLength(text);
        if (session.received > terminalLimits.logBytes) {
          session.status = 'output_limit'; session.closing = true; this.#send(session, { type: 'close' }); this.#notify(session); return;
        }
        session.log = session.log.then(async () => {
          // Immutable ordinary spool chunks, with native pipe/PTY backpressure until persisted.
          for (let start = 0; start < text.length; start += 16_384) {
            let end = Math.min(text.length, start + 16_384);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
            const part = text.slice(start, end);
            const file = await this.#writeFile(`terminal:${session.id}:${session.chunks.length}`, part);
            const bytes = Buffer.byteLength(part);
            session.chunks.push({ path: file.path, start: session.bytes, end: session.bytes + bytes, sha256: createHash('sha256').update(part).digest('hex') }); session.bytes += bytes;
            if (end < Math.min(text.length, start + 16_384)) start--;
          }
          this.#send(session, { type: 'ack' }); this.#notify(session);
        }).catch(error => { session.failure = error; session.status = 'unknown'; session.closing = true; this.#send(session, { type: 'close' }); this.#notify(session); });
      } else if (message.type === 'output_limit') {
        session.status = 'output_limit'; session.closing = true; this.#notify(session);
      } else if (message.type === 'output_incomplete' || message.type === 'cleanup_unknown') {
        session.status = 'unknown'; this.#notify(session);
      } else if (message.type === 'exit' || message.type === 'process_exit') {
        session.code = message.code ?? null; session.signal = message.signal ?? null;
        // Wait for host close before advertising complete output.
      } else if (message.type === 'error') {
        session.failure = new TerminalError(message.error === 'pty_unavailable' ? 'PTY unavailable. Run pnpm terminal:prepare on a supported Mac/Linux host; no command was confirmed started.' : 'Terminal process could not be started.');
        session.status = 'unknown';
      }
    });
    host.once('error', error => { session.failure = error; });
    host.once('close', () => {
      session.closing = false;
      if (session.status === 'running') session.status = session.code !== null || session.signal !== null ? 'exited' : 'unknown';
      for (const request of session.requests.values()) request.reject(Error('Terminal exited before input acknowledgement; its effect is unknown'));
      session.requests.clear(); session.resolveDone(); this.#notify(session);
    });
    this.#send(session, { type: 'start', command: args.command, cwd: args.cwd ?? this.#cwd, shell: args.shell ?? '/bin/bash', tty: args.tty ?? false });
    // Cancellation after spawn only cancels this wait, never silently kills/replays the process.
    return this.#serial(session, () => this.#collect(session, 0, args.yield_ms ?? 1000, args.max_output_bytes ?? terminalLimits.outputBytes, signal));
  }
  async write(owner: string, args: TerminalWrite, signal?: AbortSignal): Promise<TerminalResult> {
    this.#options(args.yield_ms, args.max_output_bytes);
    if (!integer(args.offset, 0, Number.MAX_SAFE_INTEGER) || Buffer.byteLength(args.chars ?? '') > 32_768) throw new TerminalError('Invalid terminal offset or input');
    const session = this.#lookup(owner, args.session_id);
    if (!session) return this.#unavailable(args.session_id, args.offset);
    return this.#serial(session, async () => {
      signal?.throwIfAborted();
      await this.#validateOffset(session, args.offset);
      signal?.throwIfAborted();
      if ((args.chars || args.interrupt) && session.status !== 'running') throw new TerminalError('Cannot write to an ended terminal');
      if (args.chars) await this.#request(session, { type: 'write', text: args.chars }, signal);
      if (args.interrupt) await this.#request(session, { type: 'interrupt' }, signal);
      return this.#collect(session, args.offset, args.yield_ms ?? 1000, args.max_output_bytes ?? terminalLimits.outputBytes, signal);
    });
  }
  async #validateOffset(session: Session, offset: number): Promise<void> {
    if (!integer(offset, 0, session.bytes)) throw new TerminalError('Offset is beyond persisted output');
    const chunk = session.chunks.find(chunk => chunk.start <= offset && offset < chunk.end);
    if (chunk && ((await this.#readChunk(chunk))[offset - chunk.start]! & 0xc0) === 0x80) throw new TerminalError('Offset must be a UTF-8 character boundary; use next_offset');
  }
  async #readChunk(chunk: Chunk): Promise<Buffer> {
    const data = await readFile(chunk.path);
    if (data.length !== chunk.end - chunk.start || createHash('sha256').update(data).digest('hex') !== chunk.sha256) throw Error('Terminal log integrity mismatch');
    return data;
  }
  async #collect(session: Session, offset: number, yieldMs: number, maxBytes: number, signal?: AbortSignal): Promise<TerminalResult> {
    const until = Date.now() + yieldMs;
    while (session.status === 'running' && session.bytes <= offset && Date.now() < until && !signal?.aborted) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); session.changes.delete(done); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.max(0, until - Date.now())); session.changes.add(done); signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
    for (;;) { const pending = session.log; await pending; if (pending === session.log) break; }
    const snapshot = { bytes: session.bytes, chunks: [...session.chunks], status: session.status, code: session.code, signal: session.signal };
    if (session.failure) throw session.failure;
    const buffers: Buffer[] = []; let length = 0;
    for (const chunk of snapshot.chunks) {
      if (chunk.end <= offset) continue;
      const data = await this.#readChunk(chunk);
      const part = data.subarray(Math.max(0, offset - chunk.start), Math.min(data.length, Math.max(0, offset - chunk.start) + maxBytes - length));
      buffers.push(part); length += part.length; if (length >= maxBytes) break;
    }
    let data = Buffer.concat(buffers);
    if (data.length && (data[0]! & 0xc0) === 0x80) throw new TerminalError('Offset must be a UTF-8 character boundary; use the returned next_offset');
    // A byte cap may split the last character. Trim only that incomplete suffix.
    let output: string;
    for (;;) { try { output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); break; } catch { data = data.subarray(0, -1); } }
    const index = await this.#writeFile(`terminal-index:${session.id}:${snapshot.bytes}`, JSON.stringify({ session_id: session.id, encoding: 'utf8', bytes: snapshot.bytes, chunks: snapshot.chunks }, null, 2));
    return { session_id: session.id, status: snapshot.status, output, offset, next_offset: offset + data.length, has_more: offset + data.length < snapshot.bytes,
      exit_code: snapshot.code, signal: snapshot.signal, cleanup_scope: 'Managed process group and descendants observable at close only. Regrouped and reparented jobs may survive; effects are not undone.', log_index: index.path, input_bytes_remaining: 1024 * 1024 - session.inputBytes,
      ...(signal?.aborted ? { message: 'Wait cancelled; the terminal was not terminated. Use write_stdin to continue or terminal_close to terminate.' } : snapshot.status === 'output_limit' ? { message: 'Terminal output limit reached (64 MiB total or 1 MiB pending PTY output). Excess output was not retained; termination requested.' } : snapshot.status === 'unknown' ? { message: 'Terminal host did not confirm complete output or cleanup. Inspect effects; do not replay automatically.' } : {}) };
  }
  async closeSession(owner: string, id: string, offset = 0): Promise<TerminalResult> {
    const session = this.#lookup(owner, id); if (!session) return this.#unavailable(id, offset);
    return this.#serial(session, async () => {
      await this.#validateOffset(session, offset);
      if (session.status === 'running') { session.status = 'closed'; session.closing = true; this.#send(session, { type: 'close' }); this.#notify(session); }
      await session.done;
      return this.#collect(session, offset, 0, terminalLimits.outputBytes);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions.values()].map(async session => {
      if (session.status === 'running') session.status = 'closed';
      this.#send(session, { type: 'close' }); this.#notify(session); await session.done; await session.log;
    }));
  }
}

export function createTerminalTools(manager: TerminalManager, owner: string): AgentTool[] {
  const yieldMs = Type.Optional(Type.Integer({ minimum: 0, maximum: terminalLimits.yieldMs, description: 'Wait budget, default 1000 ms. Yield does not terminate the process.' }));
  const maxBytes = Type.Optional(Type.Integer({ minimum: 4, maximum: terminalLimits.outputBytes }));
  const session = Type.String({ format: 'uuid', description: 'Exact session_id returned in this stream. Main and child sessions are isolated.' });
  const offset = Type.Integer({ minimum: 0, description: 'Copy next_offset from the last result. Use 0 to reread output without re-executing.' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
  const call = async (work: () => Promise<unknown>) => { try { return result(await work()); } catch (error) { if (error instanceof TerminalError) return result({ error: error.message }); throw error; } };
  return [
    { name: 'terminal_list', label: 'List owned terminals', description: 'List only this stream’s service-local terminal handles, including launch_call_id. Use this to inspect a launch whose durable result is unknown or was cancelled, without replaying it. Restart does not recover old handles.', parameters: Type.Object({}), execute: async () => result(manager.list(owner)) },
    { name: 'exec_command', label: 'Start terminal process', description: 'Start a fresh shell command, optionally with a real PTY. Returns incremental output and a session_id after bounded waiting; processes can continue across conversation turns until explicitly closed or the service stops. To retain cwd/env, explicitly start an interactive shell with tty=true and command="exec /bin/bash --noprofile --norc -i" and use write_stdin. Each exec is independent. Ordinary OS permissions, not a sandbox. Full output is in immutable ordinary files referenced by log_index. No restart/replay. Regrouped/reparented background jobs can outlive shell exit; close jobs explicitly while their shell is alive.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 32_768 }), cwd: Type.Optional(Type.String()), shell: Type.Optional(Type.String()), tty: Type.Optional(Type.Boolean()), yield_ms: yieldMs, max_output_bytes: maxBytes }),
      execute: (_id, args, signal) => call(() => manager.exec(owner, args as TerminalExec, signal, _id)) },
    { name: 'write_stdin', label: 'Continue terminal process', description: 'Read incremental output or send text to a live terminal in this stream. Copy next_offset. Empty chars only polls; interrupt=true sends Ctrl-C to a PTY foreground job or SIGINT to a pipe process group, and may leave an interactive shell alive. Cancelling the wait does not kill the process. Each input is at most 32 KiB UTF-8; the per-session cumulative input budget is 1 MiB. Acknowledgement means the supervisor queued it, not that the program consumed it. Writes are serialized per session; different sessions are independent. Service restart invalidates all handles.',
      parameters: Type.Object({ session_id: session, offset, chars: Type.Optional(Type.String({ maxLength: 32_768 })), interrupt: Type.Optional(Type.Boolean()), yield_ms: yieldMs, max_output_bytes: maxBytes }),
      execute: (_id, args, signal) => call(() => manager.write(owner, args as TerminalWrite, signal)) },
    { name: 'terminal_close', label: 'Close terminal process', description: 'Explicitly terminate this managed terminal process group and observed descendants, then read remaining output. Does not undo effects. Saved logs remain ordinary files. Processes that regroup and reparent, including ordinary interactive background jobs after shell exit, may survive. This is not a complete process-tree guarantee.',
      parameters: Type.Object({ session_id: session, offset }), execute: (_id, args) => call(() => manager.closeSession(owner, (args as { session_id: string }).session_id, (args as { offset: number }).offset)) },
  ];
}
