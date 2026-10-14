/** Public management views are deliberately separate from raw History/host data.
 * No raw configuration, tool payload, hidden thinking, system prompt, or exception
 * is part of this contract. Memory content is the one explicitly requested file. */
export interface MemoryView { configured: boolean; content: string | null; revision: string | null }
export interface MemoryReceiptView {
  state: 'unavailable' | 'pending' | 'unchanged' | 'changed';
  commit: string | null;
}
export interface AssistantReplyView { id: string; text: string; occurredAt: string }
export interface MessageStatusView {
  id: string; eventId: string | null; runId: string | null;
  state: 'unknown' | 'submitted' | 'processing' | 'completed' | 'failed';
  assistant: AssistantReplyView | null; memory: MemoryReceiptView;
  /** Current-process failure only; never represented as persisted evidence. */
  error: string | null;
}
export interface ExtensionView {
  id: string; revision: string; enabled: boolean;
  status: 'disabled' | 'import-failed' | 'waiting' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  activation: string | null; tools: string[]; contextProviders: string[];
  generated: { digest: string; revision: string; history: Array<{ id: string; digest: string }> } | null;
  /** Fixed category text only; raw host diagnostics/configuration never leave server. */
  error: string | null;
}
export interface ExtensionsView {
  available: boolean; extensions: ExtensionView[]; releases: Array<{ digest: string }>; error: string | null;
}
export type ExtensionMutation = { expectedRevision: string } & (
  { action: 'enable' | 'disable' | 'reload' }
  | { action: 'configure'; config: unknown }
  | { action: 'update'; digest: string }
  | { action: 'rollback'; revision: string }
);
export interface ExtensionMutationView {
  id: string; extensionId: string; action: ExtensionMutation['action']; status: 'applied' | 'failed';
  persistence: 'saved' | 'failed' | 'not-required' | 'not-attempted';
  runtime: ExtensionView | null; error: string | null;
}
export interface RunSummaryView { id: string; occurredAt: string; status: 'running' | 'completed'; requestCount: number }
export interface RunsView { items: RunSummaryView[]; nextCursor: string | null }
export interface RunExecutionView {
  id: string; occurredAt: string;
  kind: 'model' | 'tool' | 'subagent' | 'compaction' | 'recovery' | 'unavailable';
  name: string | null; status: string;
  /** Whitelisted fixed diagnostic only, never raw errors or payload fragments. */
  error: string | null;
}
export interface RunDetailView extends RunSummaryView {
  requests: Array<{ eventId: string; source: string; type: string; reason: string | null }>;
  nextRequestsCursor: string | null;
  assistant: AssistantReplyView | null; memory: MemoryReceiptView;
  executions: RunExecutionView[]; nextCursor: string | null;
  /** Compaction failures are not durably recorded by the current runtime. */
  compactionErrors: 'not-recorded';
  error: string | null;
}
export interface ManagementBackend {
  memory(): Promise<MemoryView>;
  messageStatus(id: string): Promise<MessageStatusView>;
  extensions(): Promise<ExtensionsView>;
  changeExtension(id: string, mutation: ExtensionMutation): Promise<ExtensionMutationView>;
  runs(before?: string): Promise<RunsView>;
  run(id: string, before?: string): Promise<RunDetailView | null>;
  runRequests(id: string, before?: string): Promise<{ items: RunDetailView['requests']; nextCursor: string | null } | null>;
}
