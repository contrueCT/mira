import { parseThinkingLevel, type ThinkingLevel } from '@mira/runtime-pi';
import { createBuiltinCatalog } from './model-catalog.ts';
import { parseModelConfiguration, type CustomConnection, type ModelConfiguration } from './model-config.ts';

export interface WebCredential { hasApiKey: boolean }
export interface WebCredentialWrite { hasApiKey?: boolean; apiKey?: string | null }
export type WebCustomConnection = Omit<CustomConnection, 'apiKeyEnv'> & WebCredential;
export type WebCustomConnectionWrite = Omit<CustomConnection, 'apiKeyEnv'> & WebCredentialWrite;
export interface WebModelConfiguration {
  defaultThinkingLevel?: ThinkingLevel;
  builtinCredentials: Record<string, WebCredential>;
  customConnections: WebCustomConnection[];
}
export interface WebModelConfigurationWrite {
  defaultThinkingLevel?: ThinkingLevel;
  builtinCredentials: Record<string, WebCredentialWrite>;
  customConnections: WebCustomConnectionWrite[];
}
// This internal placeholder adapts the CLI's existing model metadata parser.
// The web transport always supplies its own resolver and never reads this variable.
const webCredentialReference = 'MIRA_WEB_EXPLICIT_KEY';
const invalid = (): never => { throw Error('Invalid model settings'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(key => !names.includes(key))) invalid();
}
export function validWebApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/u.test(value) && !value.includes('sk-ant-oat');
}
function credential(value: Record<string, unknown>, write: boolean): WebCredentialWrite {
  if (value['hasApiKey'] !== undefined && typeof value['hasApiKey'] !== 'boolean') invalid();
  if (!write && typeof value['hasApiKey'] !== 'boolean') invalid();
  if (Object.hasOwn(value, 'apiKey') && (!write || (value['apiKey'] !== null && !validWebApiKey(value['apiKey'])))) invalid();
  return {
    ...(typeof value['hasApiKey'] === 'boolean' ? { hasApiKey: value['hasApiKey'] } : {}),
    ...(Object.hasOwn(value, 'apiKey') ? { apiKey: value['apiKey'] as string | null } : {}),
  };
}
/** Explicit metadata projection; never spread a credential-bearing object. */
export function webConnectionMetadata(connection: Omit<CustomConnection, 'apiKeyEnv'>): Omit<CustomConnection, 'apiKeyEnv'> {
  return {
    id: connection.id, ...(connection.name === undefined ? {} : { name: connection.name }),
    baseUrl: connection.baseUrl, api: connection.api,
    ...(connection.modelsUrl === undefined ? {} : { modelsUrl: connection.modelsUrl }),
    models: connection.models.map(model => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }), contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, reasoning: model.reasoning, input: [...model.input] })),
  };
}
function parseConnection(value: unknown, write: boolean): WebCustomConnectionWrite {
  const item = object(value);
  fields(item, ['id', 'name', 'baseUrl', 'api', 'modelsUrl', 'models', 'hasApiKey', ...(write ? ['apiKey'] : [])]);
  const parsed = parseModelConfiguration({ customConnections: [{
    id: item['id'], ...(item['name'] === undefined ? {} : { name: item['name'] }), baseUrl: item['baseUrl'], api: item['api'],
    ...(item['modelsUrl'] === undefined ? {} : { modelsUrl: item['modelsUrl'] }), models: item['models'], apiKeyEnv: webCredentialReference,
  }] }).customConnections[0]!;
  return { ...webConnectionMetadata(parsed), ...credential(item, write) };
}
export function parseWebConnectionWrite(value: unknown): WebCustomConnectionWrite { return parseConnection(value, true); }
function parseConfiguration(value: unknown, write: boolean): WebModelConfigurationWrite {
  const root = object(value); fields(root, ['builtinCredentials', 'customConnections', 'defaultThinkingLevel']);
  const builtinCredentials: WebModelConfigurationWrite['builtinCredentials'] = Object.create(null) as WebModelConfigurationWrite['builtinCredentials'];
  const catalog = createBuiltinCatalog();
  for (const [provider, raw] of Object.entries(object(root['builtinCredentials'] ?? {}))) {
    if (!catalog.getProvider(provider)) invalid();
    const entry = object(raw); fields(entry, ['hasApiKey', ...(write ? ['apiKey'] : [])]);
    builtinCredentials[provider] = credential(entry, write);
  }
  const entries = root['customConnections'] ?? [];
  if (!Array.isArray(entries) || entries.length > 100) return invalid();
  const customConnections = entries.map(entry => parseConnection(entry, write));
  if (new Set(customConnections.map(entry => entry.id)).size !== customConnections.length) invalid();
  return { builtinCredentials: Object.fromEntries(Object.entries(builtinCredentials)), customConnections, ...(root['defaultThinkingLevel'] === undefined ? {} : { defaultThinkingLevel: parseThinkingLevel(root['defaultThinkingLevel']) }) };
}
export function parseWebModelConfiguration(value: unknown): WebModelConfiguration { return parseConfiguration(value, false) as WebModelConfiguration; }
export function parseWebModelConfigurationWrite(value: unknown): WebModelConfigurationWrite { return parseConfiguration(value, true); }
export function webTransportConfiguration(configuration: WebModelConfiguration | WebModelConfigurationWrite): ModelConfiguration {
  return {
    ...(configuration.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: configuration.defaultThinkingLevel }),
    builtinCredentials: Object.fromEntries(Object.keys(configuration.builtinCredentials).map(provider => [provider, { apiKeyEnv: webCredentialReference }])),
    customConnections: configuration.customConnections.map(connection => ({ ...webConnectionMetadata(connection), apiKeyEnv: webCredentialReference })),
  };
}
