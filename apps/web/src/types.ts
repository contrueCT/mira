/** Browser DTOs deliberately contain no runtime trace, raw tool data or credentials. */
export interface TimelineItem {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  occurredAt: string;
}
export interface ToolActivity { id: string; name: string; status: 'running' | 'completed' | 'failed' | 'unknown' }
export interface TimelinePage { items: TimelineItem[]; nextCursor: string | null; tools: ToolActivity[] }
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
  apiKeyEnv: string;
  modelsUrl?: string;
  models: CustomModel[];
}
export type ModelSelection = { kind: 'builtin'; provider: string; model: string } | { kind: 'custom'; connection: string; model: string } | null;
export interface Settings {
  revision: string;
  configuration: { builtinCredentials: Record<string, { apiKeyEnv: string }>; customConnections: CustomConnection[] };
  selection: ModelSelection;
}
export interface CatalogModel extends CustomModel { provider: string; protocol: { id: string; name: string }; catalogBaseUrl: string | null }
export interface CatalogProvider { id: string; name: string; apiKeySupport: { supported: boolean; explanation: string }; models: CatalogModel[] }
export interface BuiltinCatalog { source: string; generatedAt: string | null; providers: CatalogProvider[] }
export interface Discovery { endpoint: string; models: { id: string; name?: string }[] }
