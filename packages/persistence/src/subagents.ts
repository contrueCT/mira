import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import type { PostgresOptions } from './index.ts';
import { SubagentError, subagentCompletionPayload, type SubagentRecord, type SubagentSpec, type SubagentTurn, type SubagentResult, type SubagentWriter, type SubagentReader, type SubagentPage, type SubagentCallView, type SubagentActivity, type SubagentActivityInput, type SubagentActivityEvent, type SubagentFollowupReceipt, type LifeEvent, type WakeReceipt } from '@mira/life';

const uuid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const validText = (text: string) => typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= 32_768;
interface Row { child_id: string; stream_id: string; spawn_call_id: string; created_at: string; spec: SubagentSpec }
interface TurnRow { input_record_id: string | null; final_record_id: string | null; turn_id: string; child_id: string; call_id: string; sequence: number; instruction: string; status: SubagentTurn['status']; created_at: string; started_at: string | null; activity: SubagentActivity; finished_at: string | null; result: SubagentResult | null }
const turn = (r: TurnRow): SubagentTurn => ({ id: r.turn_id, childId: r.child_id, callId: r.call_id, sequence: r.sequence, instruction: r.instruction, status: r.status, createdAt: r.created_at, startedAt: r.started_at, activity: r.activity, finishedAt: r.finished_at, result: r.result });
/** Terminal rows remain immutable. A cancellation can close an observation
 * before an already-dispatched child COMMIT becomes visible; project only that
 * exact summary's durable evidence, even after a crash prevented its callback. */
async function projectTurns(client: Client, miraId: string, rows: TurnRow[]): Promise<SubagentTurn[]> {
  const turns = rows.map(turn);
  const pending = turns.flatMap(value => {
    const last = value.activity.events.at(-1);
    return !['queued','running'].includes(value.status) && last?.checkpointId && last.phase === 'finished' && last.status === 'interrupted'
      ? [{ turn: value, checkpointId: last.checkpointId }] : [];
  });
  if (!pending.length) return turns;
  const evidence = await client.query<{ child_id: string; record_id: string }>(
    `SELECT child.child_id,record.record_id FROM context_records record JOIN subagents child ON child.stream_id=record.mira_id
      WHERE child.parent_mira_id=$1 AND record.record_id=ANY($2::uuid[]) AND child.child_id=ANY($3::uuid[]) AND record.envelope->>'kind'='checkpoint'`,
    [miraId,[...new Set(pending.map(value => value.checkpointId))],[...new Set(pending.map(value => value.turn.childId))]]);
  const committed = new Set(evidence.rows.map(row => `${row.child_id}:${row.record_id}`));
  for (const value of pending) if (committed.has(`${value.turn.childId}:${value.checkpointId}`)) {
    value.turn.activity = structuredClone(value.turn.activity);
    value.turn.activity.events.at(-1)!.status = 'completed';
  }
  return turns;
}
/** Bounded shared queries used by the owner and independent read-only reader. */
async function readRecord(client: Client, miraId: string, row: Row): Promise<SubagentRecord> {
  const count = (await client.query<{ count: number }>('SELECT coalesce(max(sequence),0)::integer AS count FROM subagent_turns WHERE parent_mira_id=$1 AND child_id=$2', [miraId, row.child_id])).rows[0]!.count;
  const rows = await client.query<TurnRow>(`(SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND child_id=$2 ORDER BY sequence DESC LIMIT 8)
    UNION ALL (SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND child_id=$2 AND status IN ('queued','running') ORDER BY sequence LIMIT 18)`, [miraId, row.child_id]);
  const turns = await projectTurns(client, miraId, [...new Map(rows.rows.map(row => [row.turn_id, row])).values()].sort((a,b) => a.sequence - b.sequence));
  if (turns.filter(turn => ['queued','running'].includes(turn.status)).length > 17) throw new SubagentError('invalid', 'Child pending-turn limit was exceeded');
  const receipts = (await client.query<Omit<LiveRow,'instruction'> & { turn_id: string }>('SELECT turn_id,call_id,created_at,input_record_id,status FROM subagent_live_inputs WHERE parent_mira_id=$1 AND child_id=$2 ORDER BY receipt_order DESC LIMIT 16', [miraId,row.child_id])).rows;
  const followups = receipts.reverse().map(value => ({ turnId: value.turn_id, callId: value.call_id, createdAt: value.created_at, inputRecordId: value.input_record_id, status: value.status }));
  return { id: row.child_id, streamId: row.stream_id, spawnCallId: row.spawn_call_id, createdAt: row.created_at, spec: row.spec, turnCount: count, turns, followups };
}
async function readChild(client: Client, miraId: string, id: string): Promise<SubagentRecord | null> {
  if (!uuid(id)) throw new SubagentError('invalid', 'A canonical child UUID is required');
  const row = (await client.query<Row>('SELECT * FROM subagents WHERE parent_mira_id=$1 AND child_id=$2', [miraId,id])).rows[0];
  return row ? readRecord(client,miraId,row) : null;
}
interface LiveRow { call_id: string; instruction: string; created_at: string; input_record_id: string | null; status: SubagentFollowupReceipt['status'] }
async function findCall(client: Client, miraId: string, callId: string): ReturnType<SubagentReader['findSubagentCall']> {
  if (!validText(callId)) throw new SubagentError('invalid', 'Invalid parent call ID');
  const mapping = (await client.query<{ turn_id: string; kind: 'turn' | 'live' }>('SELECT turn_id,kind FROM subagent_calls WHERE parent_mira_id=$1 AND call_id=$2', [miraId,callId])).rows[0];
  if (!mapping) return null;
  const row = (await client.query<TurnRow>('SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND turn_id=$2', [miraId,mapping.turn_id])).rows[0];
  if (!row) throw new SubagentError('invalid', 'Parent call has no child turn');
  let followup: SubagentFollowupReceipt | undefined;
  if (mapping.kind === 'live') {
    const live = (await client.query<LiveRow>('SELECT * FROM subagent_live_inputs WHERE parent_mira_id=$1 AND call_id=$2', [miraId,callId])).rows[0];
    if (!live) throw new SubagentError('invalid', 'Parent call has no live input');
    followup = { callId: live.call_id, instruction: live.instruction, createdAt: live.created_at, inputRecordId: live.input_record_id, status: live.status };
  }
  return { child: (await readChild(client,miraId,row.child_id))!, turn: (await projectTurns(client,miraId,[row]))[0]!, ...(followup ? { followup } : {}) };
}
/** Match parent call versions to the same immutable run interval as history.readRun. */
function runOwnership(parameter: string): string {
  return `EXISTS (SELECT 1 FROM subagent_calls member
    JOIN tool_executions execution ON execution.mira_id=member.parent_mira_id AND execution.call_id=member.call_id
    JOIN wake_runs run ON run.mira_id=member.parent_mira_id AND run.run_id=${parameter}::uuid
    LEFT JOIN context_records final ON final.mira_id=run.mira_id AND final.record_id=run.final_record_id
    WHERE member.child_id=s.child_id AND member.parent_mira_id=s.parent_mira_id
      AND execution.context_version > run.claimed_version
      AND (run.final_record_id IS NULL OR execution.context_version <= final.version))`;
}
async function readForRun(client: Client, miraId: string, id: string, runId: string): Promise<SubagentRecord | null> {
  if (!uuid(id) || !uuid(runId)) throw new SubagentError('invalid', 'Canonical child and run UUIDs are required');
  const row = (await client.query<Row>(`SELECT s.* FROM subagents s WHERE s.parent_mira_id=$1 AND s.child_id=$2 AND ${runOwnership('$3')}`, [miraId,id,runId])).rows[0];
  return row ? readRecord(client,miraId,row) : null;
}
type SummaryRow = { child_id: string; created_at: string; model: SubagentSpec['model']; title: string | null; status: SubagentTurn['status'] };
const summaryColumns = `s.child_id,s.created_at,s.spec->'model' AS model,s.spec->>'title' AS title,
  CASE WHEN EXISTS(SELECT 1 FROM subagent_turns t WHERE t.child_id=s.child_id AND t.status='running') THEN 'running'
  WHEN EXISTS(SELECT 1 FROM subagent_turns t WHERE t.child_id=s.child_id AND t.status='queued') THEN 'queued'
  ELSE (SELECT status FROM subagent_turns t WHERE t.child_id=s.child_id ORDER BY sequence DESC LIMIT 1) END AS status`;
function summaryPage(rows: SummaryRow[]): SubagentPage {
  const selected = rows.slice(0,50);
  return { children: selected.map(row => ({ id: row.child_id, ...(row.title ? { title: row.title } : {}), createdAt: row.created_at, status: row.status, model: row.model })), nextCursor: rows.length > 50 ? selected.at(-1)!.child_id : null };
}
/** First association to this run is append-ordered independently from child age,
 * clocks and later followups. Both page and cursor use the same immutable key. */
const runAssociations = `WITH associations AS MATERIALIZED (
  SELECT member.child_id,min(member.association_order) AS first_order FROM subagent_calls member
  JOIN tool_executions execution ON execution.mira_id=member.parent_mira_id AND execution.call_id=member.call_id
  JOIN wake_runs run ON run.mira_id=member.parent_mira_id AND run.run_id=$2::uuid
  LEFT JOIN context_records final ON final.mira_id=run.mira_id AND final.record_id=run.final_record_id
  WHERE member.parent_mira_id=$1 AND execution.context_version > run.claimed_version
    AND (run.final_record_id IS NULL OR execution.context_version <= final.version)
  GROUP BY member.child_id)`;
async function listRunChildren(client: Client, miraId: string, runId: string, before?: string): Promise<SubagentPage> {
  if (!uuid(runId)) throw new SubagentError('invalid', 'A canonical run UUID is required');
  let boundary: string | undefined;
  if (before !== undefined) {
    if (!uuid(before)) throw new SubagentError('invalid', 'A canonical child boundary is required');
    boundary = (await client.query<{ first_order: string }>(`${runAssociations}
      SELECT first_order::text FROM associations WHERE child_id=$3::uuid`, [miraId,runId,before])).rows[0]?.first_order;
    if (boundary === undefined) throw new SubagentError('missing', 'List boundary child does not exist in this run');
  }
  const rows = await client.query<SummaryRow>(`${runAssociations}
    SELECT ${summaryColumns} FROM associations association
    JOIN subagents s ON s.child_id=association.child_id AND s.parent_mira_id=$1
    ${boundary === undefined ? '' : 'WHERE association.first_order < $3::bigint'}
    ORDER BY association.first_order DESC LIMIT 51`, [miraId,runId,...(boundary === undefined ? [] : [boundary])]);
  return summaryPage(rows.rows);
}
async function listChildren(client: Client, miraId: string, before?: string, runId?: string): Promise<SubagentPage> {
  if (runId !== undefined) return listRunChildren(client,miraId,runId,before);
  let boundary: { created_at: string; child_id: string } | undefined;
  if (before !== undefined) {
    if (!uuid(before)) throw new SubagentError('invalid', 'A canonical child boundary is required');
    boundary = (await client.query<{ created_at: string; child_id: string }>('SELECT created_at,child_id FROM subagents WHERE parent_mira_id=$1 AND child_id=$2', [miraId,before])).rows[0];
    if (!boundary) throw new SubagentError('missing', 'List boundary child does not exist');
  }
  const rows = await client.query<SummaryRow>(`SELECT ${summaryColumns} FROM subagents s WHERE s.parent_mira_id=$1
    ${boundary ? 'AND (s.created_at,s.child_id)<($2::text,$3::uuid)' : ''}
    ORDER BY s.created_at DESC,s.child_id DESC LIMIT 51`, [miraId,...(boundary ? [boundary.created_at,boundary.child_id] : [])]);
  return summaryPage(rows.rows);
}
async function readCalls(client: Client, miraId: string, callIds: string[]): Promise<SubagentCallView[]> {
  if (callIds.length > 50 || callIds.some(id => !validText(id))) throw new SubagentError('invalid', 'At most fifty valid parent call IDs are supported');
  if (!callIds.length) return [];
  const rows = await client.query<{ call_id: string; run_id: string | null; child_id: string; stream_id: string; turn_id: string; created_at: string; status: SubagentTurn['status'] }>(
    `SELECT t.call_id,t.child_id,s.stream_id,t.turn_id,t.created_at,turn.status,
       (SELECT run.run_id FROM tool_executions execution
        JOIN wake_runs run ON run.mira_id=execution.mira_id
        LEFT JOIN context_records final ON final.mira_id=run.mira_id AND final.record_id=run.final_record_id
        WHERE execution.mira_id=t.parent_mira_id AND execution.call_id=t.call_id
          AND execution.context_version > run.claimed_version
          AND (run.final_record_id IS NULL OR execution.context_version <= final.version)
        ORDER BY run.claimed_version DESC LIMIT 1) AS run_id
      FROM subagent_calls t
     JOIN subagent_turns turn ON turn.turn_id=t.turn_id
     JOIN subagents s ON s.child_id=t.child_id AND s.parent_mira_id=t.parent_mira_id
     WHERE t.parent_mira_id=$1 AND t.call_id=ANY($2::text[]) ORDER BY t.created_at,t.turn_id LIMIT 50`, [miraId,callIds]);
  return rows.rows.map(row => ({ callId: row.call_id, runId: row.run_id, childId: row.child_id, streamId: row.stream_id, turnId: row.turn_id, createdAt: row.created_at, status: row.status }));
}

/** Independent read-only connection: inspecting evidence survives owner loss. */
export class PostgresSubagentReader implements SubagentReader {
  readonly #options: PostgresOptions;
  readonly #miraId: string;
  constructor(options: PostgresOptions, miraId: string) { this.#options = { ...options }; this.#miraId = miraId; }
  async #read<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.#options.connectionString, connectionTimeoutMillis: 5_000, application_name: 'mira-child-history-reader' });
    let failure: Error | undefined;
    client.on('error', (error: Error) => { failure = error; });
    try {
      await client.connect();
      await client.query(`SET search_path TO "${this.#options.schema ?? 'public'}"`);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      if (failure) throw failure;
      await client.query('COMMIT'); return result;
    } finally { await client.end().catch(() => {}); }
  }
  listSubagents: SubagentReader['listSubagents'] = before => this.#read(client => listChildren(client,this.#miraId,before));
  getSubagent: SubagentReader['getSubagent'] = id => this.#read(client => readChild(client,this.#miraId,id));
  getSubagentForRun: SubagentReader['getSubagentForRun'] = (id,runId) => this.#read(client => readForRun(client,this.#miraId,id,runId));
  readSubagentsForRun: SubagentReader['readSubagentsForRun'] = (runId,before) => this.#read(client => listChildren(client,this.#miraId,before,runId));
  findSubagentCall: SubagentReader['findSubagentCall'] = callId => this.#read(client => findCall(client,this.#miraId,callId));
  readSubagentCalls: SubagentReader['readSubagentCalls'] = callIds => this.#read(client => readCalls(client,this.#miraId,callIds));
}

/** No connection/lock of its own: every public operation runs inside the owner transaction. */
export class PostgresSubagents {
  private readonly client: Client;
  private readonly miraId: string;
  private readonly transaction: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly receive: (event: LifeEvent, wake: WakeReceipt) => Promise<string | null>;
  private readonly notify: (runId: string | null) => void;
  constructor(client: Client, miraId: string, transaction: <T>(work: () => Promise<T>) => Promise<T>, receive: (event: LifeEvent, wake: WakeReceipt) => Promise<string | null>, notify: (runId: string | null) => void) {
    this.client = client; this.miraId = miraId; this.transaction = transaction; this.receive = receive; this.notify = notify;
  }
  #record(row: Row): Promise<SubagentRecord> { return readRecord(this.client,this.miraId,row); }
  #get(id: string): Promise<SubagentRecord | null> { return readChild(this.client,this.miraId,id); }
  async #capacity(max: number, childId?: string): Promise<void> {
    if (!Number.isInteger(max) || max < 1 || max > 32) throw new SubagentError('invalid', 'Concurrency must be between 1 and 32');
    const rows = await this.client.query<{ child_id: string }>("SELECT DISTINCT child_id FROM subagent_turns WHERE parent_mira_id=$1 AND status IN ('queued','running')", [this.miraId]);
    if (!rows.rows.some(row => row.child_id === childId) && rows.rows.length >= max) throw new SubagentError('capacity', 'All child slots are occupied; wait or cancel an existing child');
  }
  async #lock(id: string): Promise<void> {
    if (!uuid(id)) throw new SubagentError('invalid', 'A canonical child UUID is required');
    const row = (await this.client.query('SELECT child_id FROM subagents WHERE parent_mira_id=$1 AND child_id=$2 FOR UPDATE', [this.miraId,id])).rows[0];
    if (!row) throw new SubagentError('missing', 'Child does not exist in this Mira');
  }
  async #insertTurn(childId: string, callId: string, instruction: string, sequence: number): Promise<void> {
    const id = randomUUID(), createdAt = new Date().toISOString();
    await this.client.query("INSERT INTO subagent_calls(parent_mira_id,call_id,child_id,turn_id,kind,created_at) VALUES($1,$2,$3,$4,'turn',$5)", [this.miraId,callId,childId,id,createdAt]);
    await this.client.query("INSERT INTO subagent_turns(turn_id,child_id,parent_mira_id,call_id,sequence,instruction,status,created_at,stream_id) SELECT $1,$2,$3,$4,$5,$6,'queued',$7,stream_id FROM subagents WHERE child_id=$2 AND parent_mira_id=$3", [id, childId, this.miraId, callId, sequence, instruction, createdAt]);
  }
  create: SubagentWriter['createSubagent'] = (callId, spec, max) => {
    if (!validText(callId) || !validText(spec.task) || (spec.title !== undefined && (!validText(spec.title) || !spec.title.isWellFormed() || spec.title.length > 120 || /[\r\n\0]/.test(spec.title))) || !['none', 'all'].includes(spec.fork.mode)
      || !Number.isSafeInteger(spec.fork.parentVersion) || spec.fork.parentVersion < 0
      || (spec.fork.parentHead !== null && !uuid(spec.fork.parentHead))
      || Buffer.byteLength(spec.fork.text) !== spec.fork.bytes || spec.fork.bytes > 131_072
      || (spec.fork.mode === 'none' && spec.fork.bytes !== 0)
      || !validText(spec.model.provider) || spec.model.provider.length > 256 || !validText(spec.model.id) || spec.model.id.length > 2048 || !validText(spec.model.api) || spec.model.api.length > 128 || !/^[a-f0-9]{64}$/.test(spec.model.configurationHash)) throw new SubagentError('invalid', 'Invalid bounded delegation specification');
    const frozen = structuredClone(spec);
    return this.transaction(async () => {
      const existing = (await this.client.query<Row>('SELECT * FROM subagents WHERE parent_mira_id=$1 AND spawn_call_id=$2', [this.miraId, callId])).rows[0];
      if (existing) {
        if (!isDeepStrictEqual(existing.spec, frozen)) throw new SubagentError('conflict', 'Spawn call already has a different frozen specification');
        return this.#record(existing);
      }
      if ((await this.client.query('SELECT 1 FROM subagent_calls WHERE parent_mira_id=$1 AND call_id=$2', [this.miraId,callId])).rowCount)
        throw new SubagentError('conflict', 'Parent call already identifies another child instruction');
      await this.#capacity(max);
      const id = randomUUID();
      const row = (await this.client.query<Row>('INSERT INTO subagents(child_id,parent_mira_id,stream_id,spawn_call_id,created_at,spec) VALUES($1,$2,$3,$4,$5,$6::json) RETURNING *', [id, this.miraId, `subagent:${id}`, callId, new Date().toISOString(), JSON.stringify(frozen)])).rows[0]!;
      await this.#insertTurn(id, callId, frozen.task, 1);
      return this.#record(row);
    });
  };
  list: SubagentWriter['listSubagents'] = before => this.transaction(() => listChildren(this.client,this.miraId,before));
  findCall: SubagentWriter['findSubagentCall'] = callId => this.transaction(() => findCall(this.client,this.miraId,callId));
  readCalls: SubagentWriter['readSubagentCalls'] = callIds => this.transaction(() => readCalls(this.client,this.miraId,callIds));
  get: SubagentWriter['getSubagent'] = id => this.transaction(() => this.#get(id));
  getForRun: SubagentWriter['getSubagentForRun'] = (id,runId) => this.transaction(() => readForRun(this.client,this.miraId,id,runId));
  listForRun: SubagentWriter['readSubagentsForRun'] = (runId,before) => this.transaction(() => listChildren(this.client,this.miraId,before,runId));
  send: SubagentWriter['sendSubagent'] = (callId, id, instruction, max) => {
    if (!validText(callId) || !validText(instruction)) throw new SubagentError('invalid', 'A nonblank bounded message is required');
    return this.transaction(async () => {
      await this.#lock(id);
      const child = (await this.#get(id))!;
      const existing = await findCall(this.client,this.miraId,callId);
      if (existing) {
        if (existing.child.id !== id || (existing.followup?.instruction ?? existing.turn.instruction) !== instruction)
          throw new SubagentError('conflict', 'Message call already has different content');
        return child;
      }
      await this.#capacity(max, id);
      const pending = (await this.client.query<{ count: number }>("SELECT count(*)::integer AS count FROM subagent_live_inputs WHERE parent_mira_id=$1 AND child_id=$2 AND status='pending'", [this.miraId,id])).rows[0]!.count;
      if (pending + child.turns.filter(t => t.status === 'queued').length >= 16) throw new SubagentError('capacity', 'Child has too many pending followups');
      const active = (await this.client.query<TurnRow>("SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND child_id=$2 AND status IN ('queued','running') AND final_record_id IS NULL ORDER BY sequence LIMIT 1", [this.miraId,id])).rows[0];
      if (active) {
        const createdAt = new Date().toISOString();
        await this.client.query("INSERT INTO subagent_calls(parent_mira_id,call_id,child_id,turn_id,kind,created_at) VALUES($1,$2,$3,$4,'live',$5)", [this.miraId,callId,id,active.turn_id,createdAt]);
        await this.client.query('INSERT INTO subagent_live_inputs(parent_mira_id,call_id,child_id,turn_id,stream_id,instruction,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [this.miraId,callId,id,active.turn_id,child.streamId,instruction,createdAt]);
      } else await this.#insertTurn(id, callId, instruction, child.turnCount + 1);
      return (await this.#get(id))!;
    });
  };
  claim: SubagentWriter['claimSubagentTurn'] = id => this.transaction(async () => {
    await this.#lock(id);
    const child = await this.#get(id);
    if (!child) throw new SubagentError('missing', 'Child does not exist');
    if (child.turns.some(t => t.status === 'running')) throw new SubagentError('conflict', 'Child already has a running turn');
    const next = child.turns.find(t => t.status === 'queued');
    if (!next) return null;
    const startedAt = new Date().toISOString();
    await this.client.query("UPDATE subagent_turns SET status='running',started_at=$2 WHERE turn_id=$1", [next.id,startedAt]);
    return { ...next, status: 'running', startedAt };
  });
  async #checkpointCommitted(childId: string, checkpointId: string): Promise<boolean> {
    // Read from the parent's live connection, never the possibly stopped child
    // writer. Exact immutable identity and stream ownership replace clock guesses.
    return (await this.client.query<{ committed: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM context_records record JOIN subagents child ON child.stream_id=record.mira_id
        WHERE child.parent_mira_id=$1 AND child.child_id=$2 AND record.record_id=$3::uuid AND record.envelope->>'kind'='checkpoint') AS committed`,
      [this.miraId,childId,checkpointId])).rows[0]!.committed;
  }
  async #finish(row: TurnRow, status: 'completed' | 'interrupted' | 'cancelled' | 'failed', result: SubagentResult): Promise<string | null> {
    if (!['queued', 'running'].includes(row.status)) {
      if (row.status !== status || !isDeepStrictEqual(row.result, result)) throw new SubagentError('conflict', 'Terminal child result is immutable');
      return null;
    }
    const pending = (await this.client.query<{ count: number }>("SELECT count(*)::integer AS count FROM subagent_live_inputs WHERE parent_mira_id=$1 AND turn_id=$2 AND status='pending'", [this.miraId,row.turn_id])).rows[0]!.count;
    if (status === 'completed' && pending) throw new SubagentError('conflict', 'A child with pending parent inputs cannot complete');
    if (status !== 'completed') await this.client.query("UPDATE subagent_live_inputs SET status=$3 WHERE parent_mira_id=$1 AND turn_id=$2 AND status='pending'", [this.miraId,row.turn_id,status]);
    const finishedAt = new Date().toISOString();
    const activity = structuredClone(row.activity);
    if (activity.current) {
      // A crash can follow finishTool but precede its observation callback. Do
      // not replace authoritative known evidence with an inferred unknown.
      // Persistence only checks outcome presence; opaque Pi payloads stay opaque.
      const known = activity.current.kind === 'tool' && (await this.client.query<{ known: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM tool_executions execution JOIN subagents child ON child.stream_id=execution.mira_id
          WHERE child.parent_mira_id=$1 AND child.child_id=$2 AND execution.history_id=$3::uuid AND execution.outcome IS NOT NULL) AS known`,
        [this.miraId,row.child_id,activity.current.toolHistoryId])).rows[0]!.known;
      appendActivity(activity, { ...activity.current, phase: 'finished', occurredAt: finishedAt,
        status: activity.current.kind === 'tool' ? known ? 'completed' : 'unknown'
          : activity.current.checkpointId && await this.#checkpointCommitted(row.child_id, activity.current.checkpointId) ? 'completed' : 'interrupted' });
    }
    activity.current = null;
    await this.client.query('UPDATE subagent_turns SET status=$2,finished_at=$3,result=$4::json,activity=$5::jsonb WHERE turn_id=$1', [row.turn_id, status, finishedAt, JSON.stringify(result), JSON.stringify(activity)]);
    const id = `subagent-result:${row.turn_id}`;
    return this.receive({ id, source: 'system', type: 'subagent.result', occurredAt: finishedAt,
      payload: subagentCompletionPayload({ ...turn(row), status, finishedAt, result }) }, { id, reason: 'Delegated work has a terminal result; review it without treating it as user authorization' });
  }
  finish: SubagentWriter['finishSubagentTurn'] = (id, status, result) => {
    if (!uuid(id) || !['completed', 'interrupted', 'cancelled', 'failed'].includes(status)
      || typeof result.text !== 'string' || Buffer.byteLength(result.text) > 16_384 || typeof result.truncated !== 'boolean'
      || (result.finalRecordId !== null && !uuid(result.finalRecordId))
      || (result.fullResultPath !== null && (typeof result.fullResultPath !== 'string' || !result.fullResultPath.startsWith('/') || result.fullResultPath.length > 4096))) throw new SubagentError('invalid', 'Invalid bounded child result');
    const frozen = structuredClone(result);
    return this.transaction(async () => {
      const identity = (await this.client.query<{ child_id: string }>('SELECT child_id FROM subagent_turns WHERE parent_mira_id=$1 AND turn_id=$2', [this.miraId,id])).rows[0];
      if (!identity) throw new SubagentError('missing', 'Child turn does not exist');
      await this.#lock(identity.child_id);
      const row = (await this.client.query<TurnRow>('SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND turn_id=$2', [this.miraId, id])).rows[0];
      if (!row) throw new SubagentError('missing', 'Child turn does not exist');
      return this.#finish(row, status, frozen);
    }).then(runId => { this.notify(runId); });
  };
  activity: SubagentWriter['recordSubagentActivity'] = (id, event) => {
    if (!uuid(id)) throw new SubagentError('invalid', 'A canonical turn UUID is required');
    validateActivity(event);
    const frozen = structuredClone(event);
    return this.transaction(async () => {
      const row = (await this.client.query<TurnRow>('SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND turn_id=$2', [this.miraId,id])).rows[0];
      if (!row) throw new SubagentError('missing', 'Child turn does not exist');
      // Terminal rows remain immutable; bounded reads project late committed
      // summary evidence without accepting callbacks or changing the result.
      if (row.status !== 'running') return;
      if (frozen.checkpointId && frozen.phase === 'finished' && row.activity.current?.checkpointId !== frozen.checkpointId)
        throw new SubagentError('invalid', 'Summary activity requires its exact registered checkpoint identity');
      const { callId, ...publicEvent } = frozen;
      let toolHistoryId: string | null = null;
      if (frozen.kind === 'tool') {
        const evidence = (await this.client.query<{ history_id: string }>(
          `SELECT execution.history_id FROM tool_executions execution
           JOIN subagents child ON child.stream_id=execution.mira_id
           WHERE child.parent_mira_id=$1 AND child.child_id=$2 AND execution.call_id=$3`,
          [this.miraId,row.child_id,callId])).rows[0];
        if (!evidence) throw new SubagentError('invalid', 'Activity requires a durable tool intent in this child stream');
        toolHistoryId = evidence.history_id;
      }
      const projected = { ...publicEvent, toolHistoryId };
      if (frozen.checkpointId && frozen.phase === 'finished') {
        projected.status = await this.#checkpointCommitted(row.child_id, frozen.checkpointId) ? 'completed'
          : frozen.status === 'completed' ? 'interrupted' : frozen.status;
      }
      if (Buffer.byteLength(JSON.stringify(projected)) > 3072) throw new SubagentError('invalid', 'Public activity exceeds its bounded size');
      const activity = structuredClone(row.activity);
      appendActivity(activity, projected);
      await this.client.query('UPDATE subagent_turns SET activity=$2::jsonb WHERE turn_id=$1', [id,JSON.stringify(activity)]);
    });
  };
  cancel: SubagentWriter['cancelSubagent'] = id => this.transaction(async () => {
    await this.#lock(id);
    if (!await this.#get(id)) throw new SubagentError('missing', 'Child does not exist');
    const rows = await this.client.query<TurnRow>("SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND child_id=$2 AND status IN ('queued','running') ORDER BY sequence", [this.miraId, id]);
    const runIds = new Set<string | null>();
    for (const row of rows.rows) runIds.add(await this.#finish(row, 'cancelled', { text: 'Cancelled. Already-started effects may have completed; inspect the preserved transcript before retrying.', truncated: false, fullResultPath: null, finalRecordId: null }));
    return runIds;
  }).then(runIds => { for (const runId of runIds) this.notify(runId); });
  interrupt: SubagentWriter['interruptSubagents'] = () => this.transaction(async () => {
    await this.client.query('SELECT child_id FROM subagents WHERE parent_mira_id=$1 ORDER BY child_id FOR UPDATE', [this.miraId]);
    const rows = await this.client.query<TurnRow>("SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND status IN ('queued','running') ORDER BY child_id,sequence", [this.miraId]);
    const runIds = new Set<string | null>();
    for (const row of rows.rows) runIds.add(await this.#finish(row, 'interrupted', { text: 'Process ownership changed. No child work was replayed. Explicit followup may continue after checking interrupted/unknown effects.', truncated: false, fullResultPath: null, finalRecordId: null }));
    return runIds;
  }).then(runIds => { for (const runId of runIds) this.notify(runId); });
}

function validateActivity(event: SubagentActivityInput): void {
  const keys = ['occurredAt','source','kind','phase','name','callId','status','text'];
  if (!event || keys.some(key => !Object.hasOwn(event, key)) || Object.keys(event).some(key => !keys.includes(key) && key !== 'checkpointId')
    || (Object.hasOwn(event, 'checkpointId') && (typeof event.checkpointId !== 'string' || !uuid(event.checkpointId)
      || event.kind !== 'model' || event.source !== 'runtime' || event.name !== 'context-compaction'))
    || typeof event.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt))
    || !['runtime','worker'].includes(event.source) || !['model','tool','progress'].includes(event.kind)
    || !['started','finished','reported'].includes(event.phase)
    || (event.name !== null && (typeof event.name !== 'string' || !event.name.isWellFormed() || event.name.includes('\0') || Buffer.byteLength(event.name) > 512))
    || (event.callId !== null && (typeof event.callId !== 'string' || !event.callId.isWellFormed() || event.callId.includes('\0')))
    || (event.status !== null && !['completed','failed','interrupted','succeeded','unknown'].includes(event.status))
    || (event.text !== null && (typeof event.text !== 'string' || !event.text.isWellFormed() || event.text.includes('\0') || Buffer.byteLength(event.text) > 2048))
    || (event.kind === 'progress' ? event.source !== 'worker' || event.phase !== 'reported' || !event.text?.trim() || event.name !== null || event.callId !== null || event.status !== null
      : event.source !== 'runtime' || event.text !== null || event.phase === 'reported' || !event.name || (event.kind === 'tool' ? !event.callId : event.callId !== null)
        || (event.phase === 'started' ? event.status !== null : event.status === null))) throw new SubagentError('invalid', 'Invalid public activity observation');
}
function appendActivity(activity: SubagentActivity, input: Omit<SubagentActivityEvent, 'sequence'>): void {
  const event: SubagentActivityEvent = { ...input, sequence: activity.dropped + activity.events.length + 1 };
  if (event.phase === 'started') activity.current = event;
  else if (event.phase === 'finished') activity.current = null;
  activity.events.push(event);
  if (activity.events.length > 40) { activity.events.shift(); activity.dropped++; }
  activity.updatedAt = event.occurredAt;
}
