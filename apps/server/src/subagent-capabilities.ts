import type { AgentTool } from '@earendil-works/pi-agent-core';
import { runDelegated, type RegisteredTool } from '@mira/extension-host';
import { extensionTools } from './extensions.ts';

/** ADR 0052: the tools a delegated worker gets from the extensions Mira named.
 * mainOnly tools (user messaging and similar) never reach a worker, and every
 * call runs in the host's delegated scope, where schedule changes are refused.
 * Declarations are taken fresh per model request; a call through an older
 * activation is still refused as stale by the host (ADR 0014). */
export function delegatedExtensionTools(registry: readonly RegisteredTool[], ids: readonly string[]): AgentTool[] {
  const wanted = new Set(ids);
  return extensionTools(registry.filter(entry => wanted.has(entry.extensionId) && !entry.tool.mainOnly))
    .map(tool => ({ ...tool, execute: (...args: Parameters<AgentTool['execute']>) => runDelegated(() => tool.execute(...args)) }));
}

/** Null when every ID is an active extension with at least one delegable tool. */
export function capabilityProblem(registry: readonly RegisteredTool[], ids: readonly string[]): string | null {
  const delegable = new Set(registry.filter(entry => !entry.tool.mainOnly).map(entry => entry.extensionId));
  const known = new Set(registry.map(entry => entry.extensionId));
  const mainOnly = ids.filter(id => known.has(id) && !delegable.has(id));
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) return `No active extension with tools has ID ${missing.map(id => JSON.stringify(id)).join(', ')}. Use extensions[].id from extension_inspect.`;
  if (mainOnly.length) return `Extension ${mainOnly.map(id => JSON.stringify(id)).join(', ')} only has tools reserved for Mira (for example user messaging); keep that work yourself.`;
  return null;
}
