import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';

/** ADR 0051: per-call bound for a child's file tools. bash, terminals and the
 * browser keep their own limits. */
export const SUBAGENT_FILE_TOOL_TIMEOUT_MS = 5 * 60_000;
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const MUTATING = new Set(['write', 'edit']);

const span = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
type ToolResult = Awaited<ReturnType<AgentTool['execute']>>;
const result = (value: unknown, isError = true): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {}, ...(isError ? { isError: true } : {}) }) as ToolResult;

function target(cwd: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}
/** A FIFO, socket or device can block a read or write forever. */
async function special(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (info.isFIFO()) return 'a FIFO';
    if (info.isSocket()) return 'a socket';
    if (info.isCharacterDevice() || info.isBlockDevice()) return 'a device';
    return null;
  } catch { return null; }
}

/** Wrap read/write/edit/grep/find/ls: refuse special files, then abort a call
 * with no result after `timeoutMs` and say plainly that its outcome is unknown. */
export function withFileToolLimits(tools: AgentTool[], cwd: string, timeoutMs = SUBAGENT_FILE_TOOL_TIMEOUT_MS): AgentTool[] {
  return tools.map(tool => !FILE_TOOLS.has(tool.name) ? tool : {
    ...tool,
    execute: async (id, args, signal, onUpdate) => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
      try {
        const work = (async () => {
          const file = target(cwd, (args as { path?: unknown } | undefined)?.path);
          const kind = file ? await special(file) : null;
          if (kind) return result({ error: `${file} is ${kind}; file tools only work on regular files and directories. Use exec_command for streams and devices.` });
          return tool.execute(id, args, controller.signal, onUpdate);
        })();
        const outcome = await Promise.race([work, expired]);
        if (outcome !== 'timeout') return outcome;
        controller.abort(new Error('File tool timed out'));
        void work.catch(() => undefined);
        return result({ status: 'unknown', tool: tool.name, timeoutMs,
          note: MUTATING.has(tool.name)
            ? `No result within ${span(timeoutMs)}; the call was aborted. Whether the file changed is unknown; read it before retrying.`
            : `No result within ${span(timeoutMs)}; the call was aborted. This tool changes nothing.` });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  });
}
