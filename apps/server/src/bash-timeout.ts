import type { AgentTool } from '@earendil-works/pi-agent-core';

/** Pi's bash has no default timeout. Insertions wait for the current tool and
 * there is no stop control, so one hung command (prompt, `tail -f`, network
 * wait) would block a whole Wake. Default and cap the timeout here. */
export const bashTimeouts = { defaultSeconds: 120, maxSeconds: 600 } as const;
const hint = 'For long-running, interactive or streaming commands, use exec_command (managed terminal) and poll with write_stdin instead of bash.';

// The declaration (description and parameter schema) is deliberately left
// byte-identical: recorded native-model evidence (docs/acceptance/
// reply-native-behavior.md) is bound to the complete tool-declaration digest,
// and changing it requires a new native capture. The model learns the limit and
// the managed-terminal alternative from the timeout error itself.
export function withBashTimeout(tool: AgentTool, limits: { defaultSeconds: number; maxSeconds: number } = bashTimeouts): AgentTool {
  if (tool.name !== 'bash') return tool;
  const explain = (message: string) => `${message}\nbash commands time out after ${limits.defaultSeconds} seconds by default (at most ${limits.maxSeconds}). ${hint}`;
  return {
    ...tool,
    execute: async (id, args, signal, onUpdate) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const requested = input['timeout'];
      const timeout = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(requested, limits.maxSeconds) : limits.defaultSeconds;
      try {
        return await tool.execute(id, { ...input, timeout } as never, signal, onUpdate);
      } catch (error) {
        if (error instanceof Error && /Command timed out after/u.test(error.message)) throw new Error(explain(error.message));
        throw error;
      }
    },
  };
}
