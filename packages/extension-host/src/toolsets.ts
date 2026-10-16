import { validateToolSchema } from './tool-schema.ts';
import { randomUUID } from 'node:crypto';
import type { ExtensionTool, ExtensionToolset } from '@mira/extension-sdk';

/** A synchronous publication boundary; the host owns admission and leases. */
export function createToolset<T extends { tool: ExtensionTool }>(options: {
  registry: Map<string, T>;
  reserved: ReadonlySet<string>;
  assertActive(): void;
  wrap(tool: ExtensionTool, revision: string): T;
  cleanup(cleanup: () => void): void;
}, initial: readonly ExtensionTool[]): ExtensionToolset {
  let owned = new Map<string, T>();
  const replace = (tools: readonly ExtensionTool[]): { revision: string } => {
    options.assertActive();
    if (!Array.isArray(tools) || tools.length > 256) throw new Error('Invalid extension toolset');
    const revision = randomUUID();
    const next = new Map<string, T>();
    // Read/clone/validate every candidate before mutating the live registry.
    for (const tool of tools) {
      const snapshot = snapshotTool(tool);
      const name = snapshot.name;
      if (next.has(name) || options.reserved.has(name) || (options.registry.has(name) && options.registry.get(name) !== owned.get(name))) throw new Error('Duplicate extension tool name');
      next.set(name, options.wrap(snapshot, revision));
    }
    options.assertActive();
    for (const [name, value] of owned) if (options.registry.get(name) === value) options.registry.delete(name);
    for (const [name, value] of next) options.registry.set(name, value);
    owned = next;
    return { revision };
  };
  replace(initial);
  options.cleanup(() => { for (const [name, value] of owned) if (options.registry.get(name) === value) options.registry.delete(name); });
  return Object.freeze({ replace });
}

export function snapshotTool(tool: ExtensionTool): ExtensionTool {
  const { name, description, parameters, execute } = tool;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid extension tool name: use 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore');
  if (typeof description !== 'string' || !description.trim() || typeof execute !== 'function') throw new Error('Invalid extension tool');
  if (!parameters || parameters.type !== 'object' || (parameters.required !== undefined && (!Array.isArray(parameters.required) || !parameters.required.every(item => typeof item === 'string'))) || (parameters.properties !== undefined && (typeof parameters.properties !== 'object' || parameters.properties === null || Array.isArray(parameters.properties)))) throw new Error('Invalid extension tool schema');
  const visit = (value: unknown, seen: Set<object>): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Extension schema must be finite JSON');
    seen.add(value);
    if (Array.isArray(value)) for (const item of value) visit(item, seen);
    else { if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Extension schema must be plain JSON'); for (const item of Object.values(value)) visit(item, seen); }
    seen.delete(value);
  };
  visit(parameters, new Set());
  const snapshot = structuredClone(parameters);
  validateToolSchema(snapshot);
  return { name, description, parameters: snapshot, execute: execute.bind(tool) };
}
