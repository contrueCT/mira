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
  return registry.map(({ extensionId, activation, digest, tool }) => ({
    name: tool.name, label: tool.name,
    // Existing Pi declaration deltas persist activation identity even when a code
    // reload retains the same schema. This is an instance ID, not a source hash.
    description: `${tool.description}\nExtension ${JSON.stringify(extensionId)}, activation ${activation}.${digest ? ` Content SHA-256 ${digest}.` : ''}`,
    parameters: Type.Unsafe(structuredClone(tool.parameters)),
    execute: async (callId, args, signal) => {
      const result = await tool.execute(args as Json, { callId, signal: signal ?? new AbortController().signal });
      return { content: [{ type: 'text' as const, text: result.text }], details: result.details ?? null };
    },
  }));
}
/** Ordinary model-selected tools use the same durable Pi intent/outcome path. */
export function extensionManagementTools(host: ExtensionHost): AgentTool[] {
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: null });
  return [
    { name: 'extension_inspect', label: 'Inspect trusted extensions', description: 'Inspect configured local trusted extensions, current Cordis lifecycle and accepted change receipts. Waiting means a required service is absent. Diagnostics are observations; an active old instance after an import failure is not an atomic rollback guarantee.',
      parameters: Type.Object({}), execute: async () => {
        let releases: unknown;
        try { releases = await host.releases(); } catch (error) { releases = { error: error instanceof Error ? error.message : String(error) }; }
        return result({ extensions: host.inspect(), releases, changes: host.changeStatus(), diagnostics: host.diagnosticsLog() });
      } },
    { name: 'extension_stage', label: 'Stage extension files', description: 'Copy a complete ordinary workspace and its explicit local dependencies into a content-addressed release without importing code or running scripts. No registry installation. Supply expectedDigest to bind an already measured/tested identity; mutation is rejected. Tests run explicitly through normal bash and artifact CLI. Staging does not grant authority to execute the code.',
      parameters: Type.Object({ sourceRoot: Type.String(), entryRelative: Type.String(), expectedDigest: Type.Optional(Type.String()) }),
      execute: async (_callId, rawArgs) => {
        const args = rawArgs as { sourceRoot: string; entryRelative: string; expectedDigest?: string };
        try { return result(await host.stage(args.sourceRoot, args.entryRelative, args.expectedDigest)); }
        catch (error) { return result({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: 'extension_manage', label: 'Manage extensions', description: 'Manage ordinary local extensions. install saves a staged digest as disabled under a new ID; activate enables it; update selects a staged digest (optional config); rollback selects an explicit saved revision restoring its code and config; remove unregisters and removes desired config, retaining source/releases. Enable, disable, configure and reload are also supported. Generated versions import into fresh module paths; rollback is not atomic and cannot undo external effects. Code executes with the host OS identity, without product isolation. Changes are accepted now and applied after this whole batch, before the next model request. Inspect separate artifact/test, saved and applied states. Failed apply can leave desired config saved for restart. A passed synthetic test is evidence, not a safety guarantee. Unknown outcomes are not automatically replayed.',
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), action: Type.Union(['enable', 'disable', 'reload', 'configure', 'install', 'activate', 'update', 'rollback', 'remove'].map(action => Type.Literal(action))), config: Type.Optional(Type.Any()), digest: Type.Optional(Type.String()), revision: Type.Optional(Type.String()) }),
      execute: async (_callId, rawArgs) => {
        const args = rawArgs as { id: string; action: ExtensionChange['action']; config?: Json; digest?: string; revision?: string };
        try {
          let change: ExtensionChange;
          if (args.action === 'configure') {
            if (args.config === undefined) throw new Error('configure requires config');
            change = { action: args.action, config: args.config };
          } else if (args.action === 'install' || args.action === 'update') {
            if (!args.digest) throw new Error('install/update requires digest');
            change = { action: args.action, digest: args.digest, ...(args.config === undefined ? {} : { config: args.config }) };
          } else if (args.action === 'rollback') {
            if (!args.revision) throw new Error('rollback requires a saved revision');
            change = { action: args.action, revision: args.revision };
          } else change = { action: args.action };
          return result(host.requestChange(args.id, change));
        } catch (error) { return result({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
