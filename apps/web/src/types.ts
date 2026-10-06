/** Read DTOs contain no runtime trace, raw tool data or stored credentials. */
export interface TimelineItem {
  /** Original request identity for pending-message acknowledgement only. */
  externalEventId?: string;
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  occurredAt: string;
}
export interface TimelinePage { items: TimelineItem[]; nextCursor: string | null }
export interface ServerStatus { state: 'idle' | 'working' | 'error' | 'stopped'; mode: 'synthetic' | 'live'; model: string | null; error: string | null }
export interface MessageEnvelope { id: string; text: string; occurredAt: string }
export interface PendingMessage extends MessageEnvelope { state: 'sending' | 'uncertain' | 'queued'; error?: string }
export type CustomProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export interface CustomModel {
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
  hasApiKey: boolean;
  modelsUrl?: string;
  models: CustomModel[];
}
export type ModelSelection = { kind: 'builtin'; provider: string; model: string } | { kind: 'custom'; connection: string; model: string } | null;
export interface Settings {
  revision: string;
  configuration: { builtinCredentials: Record<string, ApiKeyStatus>; customConnections: CustomConnection[] };
  selection: ModelSelection;
}
export interface CatalogModel extends CustomModel { provider: string; protocol: { id: string; name: string }; catalogBaseUrl: string | null }
export interface CatalogProvider { id: string; name: string; apiKeySupport: { supported: boolean; explanation: string }; models: CatalogModel[] }
export interface BuiltinCatalog { source: string; generatedAt: string | null; providers: CatalogProvider[] }
export interface Discovery { endpoint: string; models: { id: string; name?: string }[] }

/** Secret values exist only in the transient settings form and write requests. */
export interface ApiKeyStatus { hasApiKey: boolean }
export interface ApiKeyWrite extends ApiKeyStatus { apiKey?: string | null }
export interface CustomConnectionWrite extends CustomConnection { apiKey?: string | null }
export interface SettingsWrite extends Omit<Settings, 'configuration'> {
  configuration: { builtinCredentials: Record<string, ApiKeyWrite>; customConnections: CustomConnectionWrite[] };
}
