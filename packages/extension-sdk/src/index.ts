import type { ExtensionCredentials, ExtensionSettingsDefinition, ExtensionSettingsActions } from './settings.ts';
export type { ExtensionCredentials, ExtensionSettingField, ExtensionConnectionStatus, ExtensionSettingsDefinition, ExtensionSettingsActions, ExtensionSettingsOperation } from './settings.ts';
/** The only Mira contract trusted local extensions import. No framework/DB types. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Cleanup = () => void | Promise<void>;
export interface ExtensionTool {
  /** 1-64 ASCII letters, digits, underscores or hyphens; start with a letter or underscore. Used unchanged on model APIs. */
  name: string;
  description: string;
  parameters: { type: 'object'; properties?: { [key: string]: Json }; required?: string[]; additionalProperties?: boolean | { [key: string]: Json }; [key: string]: Json | undefined };
  execute(arguments_: Json, context: { callId: string; signal: AbortSignal }): Promise<{ text: string; details?: Json; isError?: boolean }>;
}
/** One installation-owned dynamic collection. Replacing validates the entire
 * candidate before publishing; begun calls retain their original implementation.
 * A captured, not-yet-started old declaration returns known stale/not-executed. */
export interface ExtensionToolset {
  replace(tools: readonly ExtensionTool[]): { revision: string };
}
/** Read-only observation sampled once at a natural model-request boundary.
 * Return null/empty text when unavailable. Honor cancellation; this is trusted
 * in-process code, not a sandbox or a tool-effect transaction. */
export interface ContextProvider {
  /** Unique within this extension; same portable ID syntax as tool names. */
  id: string;
  provide(context: { signal: AbortSignal }): Promise<{ text: string } | null>;
}
/** Optional immutable chat display, never a user role or action authorization.
 * Sender verification is the emitting extension's claim, not host authentication.
 * Publish outbound only after confirmed delivery; stable event IDs dedupe display. */
export interface ExtensionMessage {
  direction: 'inbound' | 'outbound';
  text: string;
  sourceLabel: string;
  senderId?: string;
  senderVerified?: boolean;
}
export interface ExtensionEvent { id: string; type: string; occurredAt: string; payload: Json; message?: ExtensionMessage }
export interface ExtensionWake { id: string; reason: string; event: ExtensionEvent }
/** Persistent one-shot UTC delivery; time-zone and reminder policy stay in extensions. */
export interface ExtensionScheduleInput {
  key: string;
  dueAt: string;
  expiresAt?: string;
  event: ExtensionEvent;
  wake?: { id: string; reason: string };
}
export interface ExtensionSchedule extends ExtensionScheduleInput {
  version: number;
  status: 'pending' | 'enqueued' | 'cancelled' | 'expired';
  createdAt: string;
  updatedAt: string;
}
export type ExtensionScheduleMutation =
  | { status: 'updated' | 'duplicate' | 'conflict' | 'settled'; delivery: ExtensionSchedule }
  | { status: 'missing'; delivery: null };
export interface ExtensionSchedules {
  create(input: ExtensionScheduleInput): Promise<ExtensionScheduleMutation>;
  get(key: string): Promise<ExtensionSchedule | null>;
  list(): Promise<ExtensionSchedule[]>;
  replace(expectedVersion: number, input: ExtensionScheduleInput): Promise<ExtensionScheduleMutation>;
  cancel(key: string, expectedVersion: number): Promise<ExtensionScheduleMutation>;
}
export interface ExtensionContext {
  readonly id: string;
  /** Installation-scoped private storage, unavailable without persistent host configuration. */
  readonly credentials: ExtensionCredentials;
  /** Private installation directory for extension-owned durable state; no sandbox guarantee. */
  readonly privateDirectory: string | null;
  registerSettings(definition: ExtensionSettingsDefinition): ExtensionSettingsActions;
  /** Host-scoped stable installation identity; retired activations cannot write. */
  readonly schedules: ExtensionSchedules;
  registerTool(tool: ExtensionTool): void;
  registerToolset(tools: readonly ExtensionTool[]): ExtensionToolset;
  registerContextProvider(provider: ContextProvider): void;
  emitEvent(event: ExtensionEvent): Promise<'inserted' | 'duplicate'>;
  requestWake(request: ExtensionWake): Promise<'inserted' | 'duplicate'>;
  provideService(name: string, value: unknown): void;
  service<T>(name: string): T;
  onCleanup(cleanup: Cleanup): void;
  /** In-process extension event bus. Listening and emitting do not request a Wake. */
  onEvent(name: string, listener: (payload: Json) => void): void;
  publish(name: string, payload: Json): void;
  interval(callback: () => void, milliseconds: number): void;
}
export interface ExtensionDefinition<C extends Json = Json> {
  name: string;
  requires?: string[];
  apply(context: ExtensionContext, config: C): void | Promise<void>;
}
const serviceKey = (name: string): string => {
  if (!/^[a-zA-Z][\w.-]*$/.test(name)) throw new Error('Invalid extension service name');
  return `mira.extension.${name}`;
};
export { serviceKey };
/** Structurally a Cordis plugin. The host supplies raw JSON, not validated C.
 * The author callback keeps its C contract and must validate incoming config. */
export function defineExtension<C extends Json>(definition: ExtensionDefinition<C>): {
  name: string; inject: string[]; apply(environment: { mira: ExtensionContext }, config: Json): void | Promise<void>;
} {
  return { name: definition.name, inject: (definition.requires ?? []).map(serviceKey),
    apply: (environment, config) => definition.apply(environment.mira, (config ?? null) as C) };
}
