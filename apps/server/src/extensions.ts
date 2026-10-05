import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ExtensionHost, type ExtensionChange, type ExtensionHostOptions, type RegisteredTool, type Json } from '@mira/extension-host';
import type { DurableWriter } from '@mira/life';

/** Bind one configured identity at assembly, never trust event payload identity.
 * Stable namespaced IDs use the existing receive transaction/dedup/Wake queue. */
export function extensionReceiver(writer: DurableWriter): ExtensionHostOptions['receive'] {
  return async (extensionId, event, wake) => writer.receive({
    id: JSON.stringify(['extension', extensionId, event.id]), type: event.type, source: 'extension', occurredAt: event.occurredAt,
    payload: { extensionId, eventId: event.id, data: event.payload },
  }, wake ? { id: JSON.stringify(['extension', extensionId, wake.id]), reason: wake.reason } : undefined);
}
export function extensionTools(registry: RegisteredTool[]): AgentTool[] {
  return registry.map(({ extensionId, activation, tool }) => ({
    name: tool.name, label: tool.name,
    // Existing Pi declaration deltas persist activation identity even when a code
    // reload retains the same schema. This is an instance ID, not a source hash.
    description: `${tool.description}\nExtension ${JSON.stringify(extensionId)}, activation ${activation}.`,
    parameters: Type.Unsafe(structuredClone(tool.parameters)),
    execute: async (callId, args, signal) => {
      const result = await tool.execute(args as Json, { callId, signal: signal ?? new AbortController().signal });
      return { content: [{ type: 'text' as const, text: result.text }], details: result.details ?? null };
    },
  }));
}
/** These are ordinary tools: authorization + durable intent/outcome stay in Pi. */
export function extensionManagementTools(host: ExtensionHost): AgentTool[] {
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: null });
  return [
    { name: 'extension.inspect', label: 'Inspect trusted extensions', description: 'Inspect configured local trusted extensions, current Cordis lifecycle and accepted change receipts. Waiting means a required service is absent. Diagnostics are observations; an active old instance after an import failure is not an atomic rollback guarantee.',
      parameters: Type.Object({}), execute: async () => result({ extensions: host.inspect(), changes: host.changeStatus(), diagnostics: host.diagnosticsLog() }) },
    { name: 'extension.manage', label: 'Manage configured extensions', description: 'Enable, disable, restart, or configure an already hand-configured trusted local extension. Changes are accepted now and applied after this entire tool batch settles, before the next natural model request. Inspect the receipt for separate saved/applied failures. A configured file is saved before apply, so failed apply can leave desired settings saved for restart. reload restarts the currently imported module; source edits are detected asynchronously by official HMR. Cannot install packages, add paths, or activate generated code.',
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), action: Type.Union([Type.Literal('enable'), Type.Literal('disable'), Type.Literal('reload'), Type.Literal('configure')]), config: Type.Optional(Type.Any()) }),
      execute: async (_callId, rawArgs) => {
        const args = rawArgs as { id: string; action: ExtensionChange['action']; config?: Json };
        try {
          if (args.action === 'configure' && args.config === undefined) throw new Error('configure requires config');
          const change: ExtensionChange = args.action === 'configure' ? { action: 'configure', config: args.config! } : { action: args.action };
          return result(host.requestChange(args.id, change));
        } catch (error) { return result({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
