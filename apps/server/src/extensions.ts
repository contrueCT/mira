import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ExtensionHost, type ExtensionChange, type ExtensionHostOptions, type ExtensionSettingsView, type RegisteredTool, type Json } from '@mira/extension-host';
import type { DurableWriter } from '@mira/life';

/** Bind one configured identity at assembly, never trust event payload identity.
 * Stable namespaced IDs use the existing receive transaction/dedup/Wake queue. */
export function extensionReceiver(writer: DurableWriter): ExtensionHostOptions['receive'] {
  return async (extensionId, event, wake) => writer.receive({
    id: JSON.stringify(['extension', extensionId, event.id]), type: event.type, source: 'extension', occurredAt: event.occurredAt,
    payload: { extensionId, eventId: event.id, data: event.payload, ...(event.message === undefined ? {} : { message: { ...event.message } }) },
  }, wake ? { id: JSON.stringify(['extension', extensionId, wake.id]), reason: wake.reason } : undefined);
}
export function extensionTools(registry: RegisteredTool[]): AgentTool[] {
  return registry.map(({ extensionId, activation, toolRevision, digest, tool }) => ({
    name: tool.name, label: tool.name,
    // Existing Pi declaration deltas persist activation identity even when a code
    // reload retains the same schema. This is an instance ID, not a source hash.
    description: `${tool.description}\nExtension ${JSON.stringify(extensionId)}, activation ${activation}.${toolRevision ? ` Toolset revision ${toolRevision}.` : ''}${digest ? ` Content SHA-256 ${digest}.` : ''}`,
    parameters: Type.Unsafe(structuredClone(tool.parameters)),
    execute: async (callId, args, signal) => {
      let result;
      try { result = await tool.execute(args as Json, { callId, signal: signal ?? new AbortController().signal }); }
      catch { throw new Error('Extension execution did not return a known outcome. Verify external effects before retrying. Raw diagnostics are hidden.'); }
      const isError = result.isError;
      if (isError !== undefined && typeof isError !== 'boolean') throw new Error('Extension returned an invalid known-outcome flag.');
      const stale = result.details !== null && typeof result.details === 'object' && !Array.isArray(result.details)
        && result.details?.['status'] === 'stale' && result.details?.['executed'] === false;
      return { content: [{ type: 'text' as const, text: result.text }], details: result.details ?? null, ...((stale || isError === true) ? { isError: true } : {}) };
    },
  }));
}
/** Ordinary model-selected tools use the same durable Pi intent/outcome path. */
/** ADR 0049: bound for waiting on one extension lifecycle change. */
export const EXTENSION_MANAGE_TIMEOUT_MS = 60_000;
export function extensionManagementTools(host: ExtensionHost, inspectSchedules?: () => Promise<unknown>, options: { manageTimeoutMs?: number } = {}): AgentTool[] {
  const safeState = (entry: ReturnType<ExtensionHost['inspect']>[number]) => ({ ...entry, diagnostic: entry.diagnostic === null ? null : 'Extension reported a problem. Raw diagnostics are hidden.' });
  const safeReceipt = (entry: Awaited<ReturnType<ExtensionHost['requestChange']>>) => ({ ...entry, ...(entry.error ? { error: 'Extension change failed. Raw diagnostics are hidden.' } : {}), runtime: entry.runtime ? safeState(entry.runtime) : null });
  const safeOperation = (view: ExtensionSettingsView | null) => ({ operation: view?.operation ? { id: view.operation.id, action: view.operation.action, state: view.operation.state } : null });
  const settingsActions = async (id: string) => {
    try {
      const view = await host.extensionSettings(id);
      return view ? { revision: view.revision, actions: view.actions.map(action => action.id), connection: { state: view.status.state, ...(view.status.code ? { code: view.status.code } : {}) } } : null;
    } catch { return null; }
  };
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: null });
  return [
    { name: 'extension_inspect', label: 'Inspect trusted extensions', description: 'Read current installed extensions, staged releases and completed management receipts. Call with {} to inspect durable schedules (including paused records belonging to removed installations), or discover an existing extension ID or rollback revision, inspect a failure, or verify current runtime state. extensions[].id is the management target (not a tool name, activation ID or digest); generated.history[].id is a rollback revision. changes[].id matches a management receipt; check status=applied/failed and persistence separately. extensions[].status=active plus tools shows a live capability; disabled means stopped, and waiting means a missing service, not success. extensions[].settings is null when unavailable, otherwise its actions are currently available settings action IDs and revision is the exact expectedRevision for settings-start. settings.connection contains only a fixed state and optional code: active extension code does not prove connected service; name_conflict means globally duplicate tool names, invalid_tools means a rejected tool catalog. Settings fields, details and authorization links are not returned. releases contain digest/directory/entry; releases.error and diagnostics report failures. This read does not activate anything. For writing code, read the mira-extension-authoring skill.' ,
      parameters: Type.Object({}), execute: async () => {
        let releases: unknown;
        try { releases = await host.releases(); } catch (error) { releases = { error: error instanceof Error ? error.message : String(error) }; }
        const extensions = await Promise.all(host.inspect().map(async entry => ({ ...safeState(entry), settings: await settingsActions(entry.id) })));
        return result({ extensions, releases, changes: host.changeStatus().map(safeReceipt), diagnostics: host.diagnosticsLog().map(() => 'Extension host reported a problem. Raw diagnostics are hidden.'), ...(inspectSchedules ? { schedules: await inspectSchedules() } : {}) });
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
    { name: 'extension_manage', label: 'Manage extensions', description: 'Apply a lifecycle/configuration change and wait for its actual result. Returns status=applied/failed, persistence, and runtime (current extension state, or null after removal); status=rejected means the request could not be confirmed, not success; status=pending means it is still applying after 60 seconds with no confirmed result yet. Check all three: saved configuration alone does not prove activation; runtime.status=waiting is not active. Continue the requested workflow in the same user request without another user message or Wake. Install adds a NEW generated extension disabled using the actual staged digest; activate enables it. After activation, use tools from the next model request; a same-batch call to a removed or replaced activation returns an explicit stale/not-executed error, never silently uses new code. Example: {"id":"weather-watch","action":"activate"}. update selects another staged digest and keeps enabled state; rollback selects an actual saved revision from inspect (not a digest). configure replaces the entire config; remove unregisters/removes desired config and deletes this installation’s private credentials, but retains source/releases and plugin data files. settings-start starts one currently available action using actionId and the exact expectedRevision from extension_inspect; settings-current reads its operation; settings-cancel requests cancellation of the exact operationId. Settings actions return only {operation:null} or {operation:{id,action,state}} with state=pending/succeeded/failed/cancelled. Starting does not imply completion; cancellation may still be pending and cannot undo external effects. Inspect again after a settings conflict; never blindly retry an uncertain operation. Credentials, settings fields, connection details and authorization links stay in the protected settings UI. No automatic registry installs. Changes execute code with host OS permissions; no sandbox or atomic rollback of external effects. Failed application may leave desired config saved. A test receipt is evidence, not safety approval. Read the extension-authoring skill for the full workflow.' ,
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
          Type.Literal('remove', { description: 'Unregister and remove desired configuration and private credentials; retain source/releases and plugin data files.' }),
          Type.Literal('settings-start', { description: 'Start a currently available settings action; requires actionId and expectedRevision from extension_inspect.' }),
          Type.Literal('settings-current', { description: 'Read only the current settings operation receipt, or null when no operation is available.' }),
          Type.Literal('settings-cancel', { description: 'Request cancellation of the exact settings operationId; inspect its receipt to verify completion.' }),
        ], { description: 'Choose the intended lifecycle or settings operation; supply only the fields needed by that operation.' }),
        config: Type.Optional(Type.Any({ description: 'Complete JSON configuration passed to extension apply. Required for configure; optional for install/update (omission preserves update config). No executable expressions; use the extension documentation for its fields.' })),
        digest: Type.Optional(Type.String({ description: 'Required for install/update: exact staged SHA-256 returned by extension_stage, after appropriate content-bound tests. Not a path or revision ID.' })),
        revision: Type.Optional(Type.String({ description: 'Required for rollback: exact generated.history[].id from extension_inspect. Not a SHA-256 digest or activation ID.' })),
        actionId: Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$', description: 'Required for settings-start: an exact available action ID from extensions[].settings.actions in extension_inspect.' })),
        expectedRevision: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Required for settings-start: exact extensions[].settings.revision from extension_inspect; fences the current activation and settings state.' })),
        operationId: Type.Optional(Type.String({ minLength: 1, description: 'Required for settings-cancel: exact operation.id from a settings-start or settings-current receipt, not an action or lifecycle receipt ID.' })),
      }),
      execute: async (_callId, rawArgs) => {
        const args = rawArgs as { id: string; action: ExtensionChange['action'] | 'settings-start' | 'settings-current' | 'settings-cancel'; config?: Json; digest?: string; revision?: string; actionId?: string; expectedRevision?: string; operationId?: string };
        if (args.action === 'settings-start' || args.action === 'settings-current' || args.action === 'settings-cancel') {
          try {
            if (args.action === 'settings-start') {
              if (!args.actionId || !args.expectedRevision) throw new Error('Missing settings action or revision');
              return result(safeOperation(await host.startSettingsAction(args.id, args.actionId, args.expectedRevision)));
            }
            if (args.action === 'settings-cancel') {
              if (!args.operationId) throw new Error('Missing settings operation');
              await host.cancelSettingsAction(args.id, args.operationId);
            }
            return result(safeOperation(await host.extensionSettings(args.id)));
          } catch { return result({ status: 'rejected', error: 'Extension settings request could not be confirmed. Inspect current state before retrying. Raw diagnostics are hidden.' }); }
        }
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
          // ADR 0049: never hold the conversation indefinitely. The change keeps
          // applying; `pending` says only that its result is not yet known.
          const applying = host.requestChange(args.id, change);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), options.manageTimeoutMs ?? EXTENSION_MANAGE_TIMEOUT_MS); });
          const settled = await Promise.race([applying, timedOut]).finally(() => clearTimeout(timer));
          if (settled === 'pending') {
            applying.catch(() => { /* the late result stays observable through extension_inspect */ });
            return result({ status: 'pending', note: 'The change is still being applied after 60 seconds; its result is not confirmed yet. Check extension_inspect later instead of repeating it. Do not assume success or failure.' });
          }
          return result(safeReceipt(settled));
        } catch (error) { return result({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
