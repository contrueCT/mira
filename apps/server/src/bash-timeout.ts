import type { AgentTool } from '@earendil-works/pi-agent-core';

/** Pi's bash has no default timeout. Insertions wait for the current tool and
 * there is no stop control, so one hung command (prompt, `tail -f`, network
 * wait) would block a whole Wake. Default and cap the timeout here. */
export const bashTimeouts = { defaultSeconds: 120, maxSeconds: 600 } as const;
const hint = 'For long-running, interactive or streaming commands, use exec_command (managed terminal) and poll with write_stdin instead of bash.';

export function withBashTimeout(tool: AgentTool, limits: { defaultSeconds: number; maxSeconds: number } = bashTimeouts): AgentTool {
  if (tool.name !== 'bash') return tool;
  const schema = tool.parameters as unknown as { properties?: Record<string, Record<string, unknown>> };
  const parameters = schema.properties?.['timeout'] ? { ...tool.parameters, properties: { ...schema.properties,
    timeout: { ...schema.properties['timeout'], description: `Timeout in seconds. Default ${limits.defaultSeconds}, maximum ${limits.maxSeconds}; larger values are reduced to the maximum.` } } } : tool.parameters;
  return {
    ...tool,
    parameters: parameters as AgentTool['parameters'],
    description: `${tool.description} Commands time out after ${limits.defaultSeconds} seconds by default (at most ${limits.maxSeconds}). ${hint}`,
    execute: async (id, args, signal, onUpdate) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const requested = input['timeout'];
      const timeout = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(requested, limits.maxSeconds) : limits.defaultSeconds;
      try {
        return await tool.execute(id, { ...input, timeout } as never, signal, onUpdate);
      } catch (error) {
        if (error instanceof Error && /Command timed out after/u.test(error.message)) throw new Error(`${error.message}\n${hint}`);
        throw error;
      }
    },
  };
}
