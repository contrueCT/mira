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
      const stale = result.details !== null && typeof result.details === 'object' && !Array.isArray(result.details)
        && result.details?.['status'] === 'stale' && result.details?.['executed'] === false;
      return { content: [{ type: 'text' as const, text: result.text }], details: result.details ?? null, ...(stale ? { isError: true } : {}) };
    },
  }));
}
/** Ordinary model-selected tools use the same durable Pi intent/outcome path. */
export function extensionManagementTools(host: ExtensionHost, inspectSchedules?: () => Promise<unknown>): AgentTool[] {
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: null });
  return [
    { name: 'extension_inspect', label: 'Inspect trusted extensions', description: 'Read current installed extensions, staged releases and completed management receipts. Call with {} to inspect durable schedules (including paused records belonging to removed installations), or discover an existing extension ID or rollback revision, inspect a failure, or verify current runtime state. extensions[].id is the management target (not a tool name, activation ID or digest); generated.history[].id is a rollback revision. changes[].id matches a management receipt; check status=applied/failed and persistence separately. extensions[].status=active plus tools shows a live capability; disabled means stopped, and waiting means a missing service, not success. releases contain digest/directory/entry; releases.error and diagnostics report failures. This read does not activate anything. For writing code, read the mira-extension-authoring skill.' ,
      parameters: Type.Object({}), execute: async () => {
        let releases: unknown;
        try { releases = await host.releases(); } catch (error) { releases = { error: error instanceof Error ? error.message : String(error) }; }
        return result({ extensions: host.inspect(), releases, changes: host.changeStatus(), diagnostics: host.diagnosticsLog(), ...(inspectSchedules ? { schedules: await inspectSchedules() } : {}) });
      } },
    { name: 'extension_stage', label: 'Stage extension files', description: 'Copy/hash a complete ordinary extension workspace plus its explicit local dependencies without importing code, running scripts or installing packages. Example: {"sourceRoot":"/absolute/my-extension","entryRelative":"src/index.ts"}. Returns digest (SHA-256), directory (immutable release workspace), entry and entryRelative, or status=rejected with error. Use the returned digest for content-bound tests and extension_manage install/update; do not guess one. Staging alone neither tests nor activates code. The mira-extension-authoring skill explains workspace creation and the normal artifact test CLI; the runtime Extensions Workspace is the configured artifact store.' ,
      parameters: Type.Object({
        sourceRoot: Type.String({ description: 'Absolute path to the complete existing authored workspace, not its entry file or the artifact store. All selected files including hidden files are staged; exclude secrets.' }),
        entryRelative: Type.String({ description: 'Actual existing entry file relative to sourceRoot; inspect the workspace first. src/index.ts is only the template default, not a guess for supplied workspaces. Use forward slashes; no leading slash, dot/dot-dot segments or backslashes.' }),
        expectedDigest: Type.Optional(Type.String({ description: 'Optional exact SHA-256 from a prior stage of identical bytes. Omit on the first stage; a mismatch rejects staging.' })),
      }),
      execute: async (_callId, rawArgs) => {
        const args = rawArgs as { sourceRoot: string; entryRelative: string; expectedDigest?: string };
        try { return result(await host.stage(args.sourceRoot, args.entryRelative, args.expectedDigest)); }
        catch (error) { return result({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: 'extension_manage', label: 'Manage extensions', description: 'Apply a lifecycle/configuration change and wait for its actual result. Returns status=applied/failed, persistence, and runtime (current extension state, or null after removal); status=rejected means invalid request, not success. Check all three: saved configuration alone does not prove activation; runtime.status=waiting is not active. Continue the requested workflow in the same user request without another user message or Wake. Install adds a NEW generated extension disabled using the actual staged digest; activate enables it. After activation, use tools from the next model request; a same-batch call to a removed or replaced activation returns an explicit stale/not-executed error, never silently uses new code. Example: {"id":"weather-watch","action":"activate"}. update selects another staged digest and keeps enabled state; rollback selects an actual saved revision from inspect (not a digest). configure replaces the entire config; remove unregisters/removes desired config but retains source/releases. No automatic registry installs. Changes execute code with host OS permissions; no sandbox or atomic rollback of external effects. Failed application may leave desired config saved. A test receipt is evidence, not safety approval. Read the extension-authoring skill for the full workflow.' ,
      parameters: Type.Object({
        id: Type.String({ minLength: 1, description: 'Configured extension ID from extension_inspect, or a new unique ID for install. Starts with an ASCII letter, followed by letters/digits/underscores/hyphens. Not a tool name, digest, activation or change receipt ID.' }),
        action: Type.Union([
          Type.Literal('install', { description: 'New generated extension, initially disabled; requires digest, optional config.' }),
          Type.Literal('activate', { description: 'Enable an installed generated extension only. For a manual configured extension, use enable.' }),
          Type.Literal('enable', { description: 'Enable an existing configured extension.' }),
          Type.Literal('disable', { description: 'Disable/unload an existing extension while retaining its configuration.' }),
          Type.Literal('reload', { description: 'Restart the configured extension; manual module code changes use the configured HMR path, not cache-busting guesses.' }),
          Type.Literal('configure', { description: 'Replace the complete config; requires config, including null if intended.' }),
          Type.Literal('update', { description: 'Select staged generated code, retaining enabled state; requires digest, optional complete config.' }),
          Type.Literal('rollback', { description: 'Select a saved generated revision and its config, preserving enabled state; requires revision from inspect.' }),
          Type.Literal('remove', { description: 'Unregister and remove desired configuration; retain source/release files.' }),
        ], { description: 'Choose the intended lifecycle operation; supply only the fields needed by that operation.' }),
        config: Type.Optional(Type.Any({ description: 'Complete JSON configuration passed to extension apply. Required for configure; optional for install/update (omission preserves update config). No executable expressions; use the extension documentation for its fields.' })),
        digest: Type.Optional(Type.String({ description: 'Required for install/update: exact staged SHA-256 returned by extension_stage, after appropriate content-bound tests. Not a path or revision ID.' })),
        revision: Type.Optional(Type.String({ description: 'Required for rollback: exact generated.history[].id from extension_inspect. Not a SHA-256 digest or activation ID.' })),
      }),
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
          return result(await host.requestChange(args.id, change));
        } catch (error) { return result({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
