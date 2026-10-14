import { open } from 'node:fs/promises';
import { parseThinkingLevel, type ThinkingLevel } from '@mira/runtime-pi';

export const customProtocols = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type CustomProtocol = typeof customProtocols[number];
export interface CustomModelConfiguration {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
}
export interface CustomConnection {
  id: string;
  name?: string;
  baseUrl: string;
  api: CustomProtocol;
  apiKeyEnv: string;
  modelsUrl?: string;
  models: CustomModelConfiguration[];
}
export interface ModelConfiguration {
  defaultThinkingLevel?: ThinkingLevel;
  builtinCredentials: Record<string, { apiKeyEnv: string }>;
  customConnections: CustomConnection[];
}
export const emptyModelConfiguration = (): ModelConfiguration => ({ builtinCredentials: {}, customConnections: [] });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a configuration object');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('Unknown model configuration field');
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('Expected a non-empty, bounded configuration string');
  return value;
}
function envName(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw Error('apiKeyEnv must name an environment variable');
  return result;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw Error('Model token limits must be positive safe integers');
  return value;
}
/** Paths are retained. URLs may not contain credentials, query tokens, or fragments. */
export function validateBaseUrl(value: unknown): string {
  const raw = text(value);
  let url: URL;
  try { url = new URL(raw); } catch { throw Error('Invalid model base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[{}]/u.test(raw)) throw Error('Model base URL must be HTTP(S), without credentials, query, fragment, or placeholders');
  return url.href.replace(/\/+$/u, '');
}
export function parseModelConfiguration(value: unknown): ModelConfiguration {
  const root = object(value); fields(root, ['builtinCredentials', 'customConnections', 'defaultThinkingLevel']);
  const builtinCredentials: ModelConfiguration['builtinCredentials'] = Object.create(null) as ModelConfiguration['builtinCredentials'];
  for (const [id, raw] of Object.entries(object(root['builtinCredentials'] ?? {}))) {
    text(id); const credential = object(raw); fields(credential, ['apiKeyEnv']);
    builtinCredentials[id] = { apiKeyEnv: envName(credential['apiKeyEnv']) };
  }
  const entries = root['customConnections'] ?? [];
  if (!Array.isArray(entries) || entries.length > 100) throw Error('customConnections must be an array of at most 100 connections');
  const ids = new Set<string>();
  const customConnections = entries.map(raw => {
    const item = object(raw); fields(item, ['id', 'name', 'baseUrl', 'api', 'apiKeyEnv', 'modelsUrl', 'models']);
    const id = text(item['id']);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw Error('Custom connection IDs must be unique lowercase identifiers');
    ids.add(id);
    const api = item['api'];
    if (!customProtocols.some(protocol => protocol === api)) throw Error('Unsupported custom API protocol');
    if (!Array.isArray(item['models']) || item['models'].length > 10_000) throw Error('Custom models must be an array of at most 10000 entries');
    const modelIds = new Set<string>();
    const models = item['models'].map(rawModel => {
      const model = object(rawModel); fields(model, ['id', 'name', 'contextWindow', 'maxTokens', 'reasoning', 'input']);
      const modelId = text(model['id']);
      if (modelIds.has(modelId)) throw Error('Duplicate custom model ID');
      modelIds.add(modelId);
      const contextWindow = positive(model['contextWindow']); const maxTokens = positive(model['maxTokens']);
      if (maxTokens > contextWindow) throw Error('maxTokens cannot exceed contextWindow');
      if (typeof model['reasoning'] !== 'boolean') throw Error('Custom model reasoning must be explicitly true or false');
      const input = model['input'];
      if (!Array.isArray(input) || input.length === 0 || input.length > 2 || !input.every(kind => kind === 'text' || kind === 'image') || new Set(input).size !== input.length) throw Error('Custom model input must explicitly list text and/or image');
      return { id: modelId, ...(model['name'] === undefined ? {} : { name: text(model['name']) }), contextWindow, maxTokens, reasoning: model['reasoning'], input: input as ('text' | 'image')[] };
    });
    const baseUrl = validateBaseUrl(item['baseUrl']);
    if (item['modelsUrl'] !== undefined) validateBaseUrl(item['modelsUrl']);
    const modelsUrl = item['modelsUrl'] === undefined ? undefined : new URL(text(item['modelsUrl'])).href;
    if (modelsUrl && new URL(modelsUrl).origin !== new URL(baseUrl).origin) throw Error('modelsUrl must use the same origin as baseUrl');
    return { id, ...(modelsUrl ? { modelsUrl } : {}), ...(item['name'] === undefined ? {} : { name: text(item['name']) }), baseUrl, api: api as CustomProtocol, apiKeyEnv: envName(item['apiKeyEnv']), models };
  });
  return { builtinCredentials, customConnections, ...(root['defaultThinkingLevel'] === undefined ? {} : { defaultThinkingLevel: parseThinkingLevel(root['defaultThinkingLevel']) }) };
}
export async function readModelConfiguration(file: string): Promise<ModelConfiguration> {
  const handle = await open(file, 'r');
  let data: Buffer;
  try {
    if (!(await handle.stat()).isFile()) throw Error('Model configuration must be a regular file');
    const buffer = Buffer.alloc(2_000_001); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 2_000_000) throw Error('Model configuration exceeds 2 MB');
    data = buffer.subarray(0, length);
  } finally { await handle.close(); }
  let json: unknown;
  try { json = JSON.parse(data.toString('utf8')); } catch { throw Error('Invalid model configuration JSON'); }
  return parseModelConfiguration(json);
}
