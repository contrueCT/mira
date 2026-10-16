/** Read DTOs contain no runtime trace, raw tool data or stored credentials. */
export interface Attachment { id: string; name: string; mimeType: string; size: number; sha256: string }
export interface ReplyReference { messageId: string; role: 'user' | 'assistant'; text: string; attachmentNames?: string[]; source?: TimelineItem['source'] }
export interface TimelineItem {
  reply?: ReplyReference;
  source?: { kind: 'extension'; extensionId: string; label: string; direction: 'inbound' | 'outbound'; senderId?: string; senderVerified?: boolean };
  attachments?: Attachment[];
  /** Original request identity for pending-message acknowledgement only. */
  externalEventId?: string;
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  occurredAt: string;
}
export interface TimelinePage { items: TimelineItem[]; nextCursor: string | null }
export interface ModelRetryStatus { phase: 'waiting' | 'requesting'; attempt: number; maxAttempts: number; delayMs: number; reason: 'rate-limit' | 'server' | 'timeout' | 'connection' }
export interface ServerStatus { modelRetry?: ModelRetryStatus | null; state: 'idle' | 'working' | 'error' | 'stopped'; mode: 'synthetic' | 'live'; model: string | null; error: string | null }
export interface MessageEnvelope { id: string; text: string; occurredAt: string; attachmentIds?: string[]; replyToMessageId?: string }
export interface PendingMessage extends MessageEnvelope { state: 'sending' | 'uncertain' | 'queued'; error?: string }
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  configuration: { defaultThinkingLevel?: ThinkingLevel; builtinCredentials: Record<string, ApiKeyStatus>; customConnections: CustomConnection[] };
  selection: ModelSelection;
}
export interface CatalogModel extends CustomModel { thinkingLevels: ThinkingLevel[]; provider: string; protocol: { id: string; name: string }; catalogBaseUrl: string | null }
export interface CatalogProvider { id: string; name: string; apiKeySupport: { supported: boolean; explanation: string }; models: CatalogModel[] }
export interface BuiltinCatalog { source: string; generatedAt: string | null; providers: CatalogProvider[] }
export interface Discovery { endpoint: string; models: { id: string; name?: string }[] }

/** Secret values exist only in the transient settings form and write requests. */
export interface ApiKeyStatus { hasApiKey: boolean }
export interface ApiKeyWrite extends ApiKeyStatus { apiKey?: string | null }
export interface CustomConnectionWrite extends CustomConnection { apiKey?: string | null }
export interface SettingsWrite extends Omit<Settings, 'configuration'> {
  configuration: { defaultThinkingLevel?: ThinkingLevel; builtinCredentials: Record<string, ApiKeyWrite>; customConnections: CustomConnectionWrite[] };
}

/** Independent browser management DTOs. Never import server/runtime types here. */
export interface MemoryView { configured: boolean; content: string | null; revision: string | null }
export interface MemoryReceipt { state: 'unavailable' | 'pending' | 'unchanged' | 'changed'; commit: string | null }
export interface AssistantReply { id: string; text: string; occurredAt: string }
export interface MessageStatus {
  id: string; eventId: string | null; runId: string | null;
  state: 'unknown' | 'submitted' | 'processing' | 'completed' | 'failed';
  assistant: AssistantReply | null; memory: MemoryReceipt; error: string | null;
}
export interface ExtensionView {
  id: string; revision: string; enabled: boolean;
  status: 'disabled' | 'import-failed' | 'waiting' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  activation: string | null; tools: string[]; contextProviders: string[];
  generated: { digest: string; revision: string; history: { id: string; digest: string }[] } | null;
  error: string | null;
}
export interface ExtensionsView { available: boolean; extensions: ExtensionView[]; releases: { digest: string }[]; error: string | null }
export type ExtensionMutation = { expectedRevision: string } & ({ action: 'enable' | 'disable' | 'reload' } | { action: 'configure'; config: unknown } | { action: 'update'; digest: string } | { action: 'rollback'; revision: string });
export interface ExtensionMutationResult {
  id: string; extensionId: string; action: ExtensionMutation['action']; status: 'applied' | 'failed';
  persistence: 'saved' | 'failed' | 'not-required' | 'not-attempted'; runtime: ExtensionView | null; error: string | null;
}
export interface RunSummary { id: string; occurredAt: string; status: 'running' | 'completed'; requestCount: number }
export interface RunsView { items: RunSummary[]; nextCursor: string | null }
export interface RunExecution { id: string; occurredAt: string; kind: 'model' | 'tool' | 'compaction' | 'recovery' | 'unavailable'; name: string | null; status: string; error: string | null }
export interface RunRequest { eventId: string; source: string; type: string; reason: string | null }
export interface RunRequestsPage { items: RunRequest[]; nextCursor: string | null }
export interface RunDetail extends RunSummary {
  requests: RunRequest[]; nextRequestsCursor: string | null;
  assistant: AssistantReply | null; memory: MemoryReceipt; executions: RunExecution[]; nextCursor: string | null;
  compactionErrors: 'not-recorded'; error: string | null;
}

export interface ChildActivityView {
  sequence: number; occurredAt: string; source: 'runtime' | 'worker';
  kind: 'model' | 'tool' | 'progress'; phase: 'started' | 'finished' | 'reported';
  name: string | null; status: string | null; text: string | null;
}
export interface ChildSummaryView {
  id: string; runId: string; title: string; createdAt: string; status: string;
  current: ChildActivityView | null; updatedAt: string | null;
}
export interface ChildDetailView extends ChildSummaryView {
  turns: Array<{ id: string; sequence: number; status: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
    activities: ChildActivityView[]; droppedActivities: number;
    result: { text: string; truncated: boolean } | null }>;
  olderTurns: number;
}
export interface ChildrenView { items: ChildSummaryView[]; nextCursor: string | null }
