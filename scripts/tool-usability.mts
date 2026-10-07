import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { validateToolArguments, type JsonObject } from '@earendil-works/pi-ai';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { ExtensionHost } from '@mira/extension-host';
import { setupMemoryWorkspace, snapshotMemory } from '@mira/workspace';
import { createHistoryTools } from '../packages/runtime-pi/src/history-tools.ts';
import { MIRA_PROMPT_SHA256, renderMiraPrompt } from '../packages/runtime-pi/src/system-prompt.ts';
import { extensionManagementTools, extensionTools } from '../apps/server/src/extensions.ts';
import { createSkillLoader } from '../apps/server/src/skills.ts';
import { readWebExtensionConfiguration } from '../apps/server/src/web-extensions.ts';
import { FixtureHistoryReader, fixtureHistoryIds, fixtureMemoryText, fixtureMiraId, historyFixtureNotice, historyFixtures } from './tool-usability-fixtures.mts';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const marker = 'mira-production-tools-usability-v2';
const canonicalNames = ['history_search', 'history_read', 'extension_inspect', 'extension_stage', 'extension_manage'];
const usage = `Production-tool usability fixture (no model, network, credentials, or database required)
  node scripts/tool-usability.mts init
  node scripts/tool-usability.mts <session> scenario|list|prompt|evidence
  node scripts/tool-usability.mts <session> call <tool-name> '<JSON arguments>'
  node scripts/tool-usability.mts <session> batch '<JSON array of {name,arguments}>'
  node scripts/tool-usability.mts <session> serve
serve accepts one JSON object per stdin line: {"command":"list"}, {"command":"prompt"},
{"command":"call","name":"tool-name","arguments":{}}, {"command":"batch","calls":[...]}, or {"command":"close"}.
Each call or batch settles one real host boundary. serve keeps one live host; separate
CLI invocations restart it from saved config. Accepted receipts and post-boundary
states are logged to evidence.jsonl. This is not a Pi durable-runtime replay test.
Extension code/native tests execute as the current OS user, without a sandbox.
init creates a blank home; opening a session uses the web CLI's actual default
extension configuration loader and real host, without an MIRA_EXTENSIONS override.
Use only synthetic code and files under the printed session directory.`;
interface Call { name: string; arguments: JsonObject }
interface Command { command: string; name?: string; arguments?: JsonObject; calls?: Call[] }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const output = (value: unknown) => console.log(JSON.stringify(value));
const definitions = (tools: AgentTool[]) => tools.map(({ name, description, parameters }) => ({ name, description, parameters }));

function scenario(root: string) {
  return {
    session: root, historyBackend: historyFixtureNotice,
    sources: { prompt: path.join(checkout, 'packages/runtime-pi/prompts/mira-system-v0.2.md'), skills: path.join(checkout, 'skills'), authoringSkill: path.join(checkout, 'skills/mira-extension-authoring/SKILL.md') },
    paths: { home: path.join(root, 'home'), memory: path.join(root, 'Memory'), draft: path.join(root, 'stage-draft'), workspace: path.join(root, 'authored-extension'), artifacts: path.join(root, 'home', 'extension-artifacts'), configuration: path.join(root, 'home', 'extensions.json'), evidence: path.join(root, 'evidence.jsonl') },
    exercises: [
      'Review the Harbor export requirements and the original Chinese reminder decision. Explain the recorded Memory change using the commit’s provenance and the original conversation, and determine what is known about the follow-up verification. Explain whether the vendor note changes the user request.',
      'Recover the final retention exception from the Harbor audit appendix, including its literal Chinese tag. Report any bounded-read or search limitations you encounter.',
      'Inspect extensions. Stage the supplied stage-draft workspace and establish from ordinary files whether staging imported its module. Do not activate the supplied draft.',
      'Using the available extension-authoring skill and ordinary files, build a runnable extension exposing harbor_metrics(values: number[]) that returns count, total and mean after scaling every value by configurable scale. Use scale 2; empty input means count 0, total 0 and mean null. Cover empty and mixed positive/negative inputs, malformed arguments and invalid configuration in native tests. Typecheck and run native tests, stage and content-test the release, install/activate, invoke through this CLI on [] and [-2,3,5], and inspect actual state. Reconfigure scale to 0.5 and verify the same mixed input, explicitly reload and verify, then disable and remove; report state and retained artifacts.',
      'Try a missing history record, an invalid history request, a stage digest mismatch, and an extension configure request missing its config. Explain actual errors and which failures changed state.',
    ],
    constraints: 'Historical records are synthetic. Memory contains a real disposable Git commit generated by the production snapshot code from synthetic notes; its association with fixture history is synthetic. Exercise permission covers only synthetic local files/code in this session. Use the tool interface to recover history rather than opening fixture implementation/data. Read production skills and their linked SDK/docs as needed. No source-checkout edits, secrets, real accounts, live providers, or external effects. Report exact calls/results, limitations, and confusing descriptions; do not claim success from accepted alone.',
  };
}
async function initialize(): Promise<void> {
  const temporary = await realpath(os.tmpdir());
  const source = await realpath(checkout);
  const relative = path.relative(source, temporary);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Tool-usability sessions must be outside the checkout; set TMPDIR to an existing external temporary directory');
  }
  const root = await mkdtemp(path.join(temporary, 'mira-tool-usability-'));
  await mkdir(path.join(root, 'stage-draft'));
  await mkdir(path.join(root, 'home'));
  await writeFile(path.join(root, 'session.json'), JSON.stringify({ marker, createdAt: new Date().toISOString() }));
  const memory = await setupMemoryWorkspace({ memoryRoot: path.join(root, 'Memory'), sourceDirectory: source });
  await writeFile(path.join(memory.memoryRoot, 'harbor-export.md'), fixtureMemoryText);
  const snapshot = await snapshotMemory({ ...memory, miraId: fixtureMiraId, runId: fixtureHistoryIds.wake, expectedRepositoryId: memory.repositoryId });
  if (!snapshot.commitId || !snapshot.changed) throw new Error('The disposable Memory fixture did not produce its initial snapshot');
  await writeFile(path.join(root, 'history.json'), JSON.stringify(historyFixtures(snapshot.commitId)));
  await writeFile(path.join(root, 'evidence.jsonl'), '');
  await writeFile(path.join(root, 'stage-draft', 'index.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(root, 'draft-imported.txt'))}, 'The draft was imported');\nthrow new Error('This synthetic draft is for file-only staging, not activation');\n`);
  output(scenario(root));
}
async function openSession(directory: string) {
  const root = await realpath(directory);
  const state = JSON.parse(await readFile(path.join(root, 'session.json'), 'utf8')) as { marker?: string };
  if (state.marker !== marker) throw new Error('Not a tool-usability fixture directory');
  const extensions = await readWebExtensionConfiguration(path.join(root, 'home'));
  const host = new ExtensionHost({ ...extensions, reservedToolNames: canonicalNames,
    receive: async () => { throw new Error('This tool-only fixture does not persist extension events'); } });
  try {
  const history = createHistoryTools(new FixtureHistoryReader(JSON.parse(await readFile(path.join(root, 'history.json'), 'utf8'))));
  const management = extensionManagementTools(host);
  await host.start();
  const log = (value: unknown) => appendFile(path.join(root, 'evidence.jsonl'), `${JSON.stringify(value)}\n`);
  await log({ type: 'host_started', at: new Date().toISOString(), pid: process.pid, historyBackend: historyFixtureNotice });
  let tools: AgentTool[] = [];
  let closed = false;
  const prepare = async () => { tools = [...history, ...management, ...extensionTools(await host.prepare())]; };
  await prepare();
  return {
    root,
    async run(command: Command): Promise<unknown> {
      if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.command !== 'string') throw new Error('Expected a command object');
      if (command.command === 'scenario') return scenario(root);
      if (command.command === 'evidence') return (await readFile(path.join(root, 'evidence.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (command.command === 'list') {
        const result = { tools: definitions(tools), historyBackend: historyFixtureNotice };
        await log({ type: 'declarations', at: new Date().toISOString(), ...result }); return result;
      }
      if (command.command === 'prompt') {
        const skills = await createSkillLoader({ sourceDirectory: checkout, miraHome: path.join(root, 'home') })(new AbortController().signal);
        const prompt = renderMiraPrompt({ MEMORY_ROOT: path.join(root, 'Memory'), MEMORY_STATE: 'The initial MEMORY.md is empty in this synthetic fixture.', CURRENT_TIME: new Date().toISOString(), EXTENSIONS_ROOT: extensions.artifactsDirectory ?? 'Not configured',
          OTHER_ENVIRONMENT_CONTEXT: `Synthetic tool-usability session at ${root}. ${historyFixtureNotice}`,
          DYNAMIC_TOOL_AND_EXTENSION_GUIDANCE: tools.map(tool => `${tool.name}: ${tool.description}`).join('\n\n'),
          CURRENT_AUTHORIZATION_CONTEXT: 'The exercise authorizes synthetic local development and execution inside the session directory only. No external accounts or effects.' });
        const result = { templateSha256: MIRA_PROMPT_SHA256, prompt: prompt + formatSkillsForPrompt(skills) };
        await log({ type: 'prompt', at: new Date().toISOString(), ...result }); return result;
      }
      const calls = command.command === 'call' ? [{ name: command.name, arguments: command.arguments }] : command.command === 'batch' ? command.calls : undefined;
      if (!Array.isArray(calls) || !calls.length) throw new Error('Expected call or nonempty batch; see help');
      // Reject the entire envelope before dispatch: malformed later calls must
      // not strand an accepted management change for an unrelated boundary.
      for (const call of calls) {
        if (!call || typeof call !== 'object' || Array.isArray(call) || typeof call.name !== 'string' || !call.name.length ||
          (call.arguments !== undefined && (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)))) {
          throw new Error('Each call must have a nonempty name and object arguments');
        }
      }
      const batchId = randomUUID(); const results: unknown[] = [];
      for (const call of calls) {
        const callId = randomUUID();
        await log({ type: 'call_started', batchId, callId, at: new Date().toISOString(), call });
        let record: unknown;
        try {
          const tool = tools.find(tool => tool.name === call?.name);
          if (!tool) throw new Error(`Tool "${String(call?.name)}" not found`);
          const args = validateToolArguments(tool, { type: 'toolCall', id: callId, name: tool.name, arguments: call.arguments ?? {} });
          const result = await tool.execute(callId, args, new AbortController().signal);
          record = { callId, name: tool.name, arguments: args, result };
        } catch (error) { record = { callId, name: call?.name, error: errorText(error) }; }
        results.push(record); await log({ type: 'call_finished', batchId, at: new Date().toISOString(), ...record as object });
      }
      await prepare();
      const settled = { extensions: host.inspect(), changes: host.changeStatus(), diagnostics: host.diagnosticsLog(), availableTools: tools.map(tool => tool.name) };
      await log({ type: 'batch_settled', batchId, at: new Date().toISOString(), ...settled });
      return { batchId, results, settled };
    },
    async close() { if (closed) return; await host.close(); closed = true; await log({ type: 'host_closed', at: new Date().toISOString(), pid: process.pid }); },
  };
  } catch (error) {
    // The caller cannot close a session that was never returned. Startup and
    // evidence failures must still dispose resources acquired by real plugins.
    try { await host.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Tool session startup and cleanup failed'); }
    throw error;
  }
}
async function main() {
  const [directory, action, ...args] = process.argv.slice(2);
  if (!directory || ['help', '--help', '-h'].includes(directory)) { console.log(usage); return; }
  if (directory === 'init') { if (action) throw new Error('init takes no path and always creates a fresh disposable directory'); await initialize(); return; }
  if (!action) throw new Error(usage);
  const session = await openSession(directory);
  try {
    if (action === 'serve') {
      output({ ready: true, session: session.root });
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const command = JSON.parse(line) as Command;
          if (command?.command === 'close') { await session.close(); output({ closed: true }); break; }
          output(await session.run(command));
        } catch (error) { output({ error: errorText(error) }); }
      }
    } else {
      const command: Command = action === 'call'
        ? { command: action, name: args[0] ?? '', arguments: JSON.parse(args[1] ?? '{}') }
        : action === 'batch' ? { command: action, calls: JSON.parse(args[0] ?? '[]') } : { command: action };
      output(await session.run(command));
    }
  } finally { await session.close(); }
}
try { await main(); } catch (error) { console.error(JSON.stringify({ error: errorText(error) })); process.exitCode = 1; }
