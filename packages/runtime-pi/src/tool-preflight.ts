import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { validatePreparationDiagnostic, type PreparationIssue, type ToolDiagnostic } from './observations.ts';

type Schema = Record<string, unknown>;
/** Resolve only declared properties and array positions; never dynamic input keys. */
function parameter(schema: Schema, label: string): { path: string; schema: Schema; parent?: Schema; key?: string } | undefined {
  if (label === 'root') return schema['properties'] && Object.hasOwn(schema['properties'] as object, 'root') ? undefined : { path: '', schema };
  let path = '', parent: Schema | undefined;
  const parts = label.split('.');
  for (const [index, key] of parts.entries()) {
    if (!/^[A-Za-z0-9_-]+$/u.test(key) || path.length + key.length + 1 > 128) return;
    const properties = schema['properties'] as Record<string, unknown> | undefined;
    const remaining = parts.slice(index).join('.');
    if (properties && Object.keys(properties).some(name => name.includes('.') && (remaining === name || remaining.startsWith(name + '.')))) return;
    const next = properties && Object.hasOwn(properties, key) ? properties[key] : /^\d+$/u.test(key) ? schema['items'] : undefined;
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    parent = schema; schema = next as Schema; path += '/' + key;
  }
  return { path, schema, ...(parent ? { parent, key: label.split('.').at(-1)! } : {}) };
}
/** Convert only pinned SDK validation markers into schema-verified facts.
 * Raw errors, received values, enum values and regexes never enter diagnostics. */
function constraint(schema: Schema, message: string): Omit<PreparationIssue, 'path'> | undefined {
  let keyword: string | undefined;
  const numeric = /^must be (<=|>=|<|>) ([-+\d.eE]+)$/u.exec(message);
  const length = /^must not have (fewer|more) than (\d+) (characters|items)$/u.exec(message);
  if (numeric) keyword = ({ '<=': 'maximum', '>=': 'minimum', '<': 'exclusiveMaximum', '>': 'exclusiveMinimum' })[numeric[1]!];
  if (length) keyword = (length[1] === 'fewer' ? 'min' : 'max') + (length[3] === 'characters' ? 'Length' : 'Items');
  if (keyword) {
    const limit = schema[keyword], observed = Number((numeric ?? length)![2]);
    if (typeof limit === 'number' && Number.isFinite(limit) && limit === observed) return { keyword, limit };
    return;
  }
  const type = /^must be (object|array|string|number|integer|boolean|null)$/u.exec(message)?.[1];
  if (type && schema['type'] === type) return { keyword: 'type', expected: type };
  if (message === 'must not have additional properties' && schema['additionalProperties'] === false) return { keyword: 'additionalProperties' };
  if (message.startsWith('must match pattern ') && typeof schema['pattern'] === 'string') return { keyword: 'pattern' };
  if (message.startsWith('must match format ') && typeof schema['format'] === 'string') return { keyword: 'format' };
  // Other schema forms keep the fixed invalid-arguments explanation and refer
  // Mira to its full current declaration; never guess a normalized failing value.
}

export function toolPreflight(tools: readonly AgentTool[], call: AgentToolCall): Extract<ToolDiagnostic, { phase: 'prepare' }> | undefined {
  const tool = tools.find(tool => tool.name === call.name);
  if (!tool) return { phase: 'prepare', category: 'tool-not-found' };
  try { validateToolArguments(tool, call); return; }
  catch (error) {
    // Public Pi 1.0.2 adds original inputs after this exact envelope. Its header
    // describes the actually normalized failures; do not revalidate raw inputs
    // with different coercion rules. Unrecognized validator faults stay fatal.
    const prefix = `Validation failed for tool "${tool.name}":\n`;
    const suffix = `\n\nReceived arguments:\n${JSON.stringify(call.arguments, null, 2)}`;
    if (!(error instanceof Error) || !error.message.startsWith(prefix) || !error.message.endsWith(suffix)) throw error;
    const header = error.message.slice(prefix.length, -suffix.length).slice(0, 16_384);
    const issues: PreparationIssue[] = [];
    for (const line of header.split('\n').slice(0, 128)) {
      if (line.length > 512) continue;
      const match = /^  - ([A-Za-z0-9_.-]+): (.+)$/u.exec(line);
      if (!match) continue;
      const resolved = parameter(tool.parameters as unknown as Schema, match[1]!);
      if (!resolved) continue;
      const required = match[2]!.startsWith('must have required properties ') && resolved.parent && Array.isArray(resolved.parent['required']) && resolved.parent['required'].includes(resolved.key);
      const detail = required ? { keyword: 'required' } : constraint(resolved.schema, match[2]!);
      if (!detail) continue;
      const issue = { path: resolved.path, ...detail };
      try { validatePreparationDiagnostic({ phase: 'prepare', category: 'invalid-arguments', issues: [...issues, issue] }); }
      catch { continue; }
      if (!issues.some(existing => JSON.stringify(existing) === JSON.stringify(issue))) issues.push(issue);
      if (issues.length === 8) break;
    }
    return { phase: 'prepare', category: 'invalid-arguments', ...(issues.length ? { issues } : {}) };
  }
}
