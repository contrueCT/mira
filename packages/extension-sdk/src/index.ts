/** The only Mira contract trusted local extensions import. No framework/DB types. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Cleanup = () => void | Promise<void>;
export interface ExtensionTool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties?: { [key: string]: Json }; required?: string[]; additionalProperties?: boolean };
  execute(arguments_: Json, context: { callId: string; signal: AbortSignal }): Promise<{ text: string; details?: Json }>;
}
export interface ExtensionEvent { id: string; type: string; occurredAt: string; payload: Json }
export interface ExtensionWake { id: string; reason: string; event: ExtensionEvent }
export interface ExtensionContext {
  readonly id: string;
  registerTool(tool: ExtensionTool): void;
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
/** Structurally a Cordis plugin, without exposing Cordis to extension authors. */
export function defineExtension<C extends Json>(definition: ExtensionDefinition<C>): {
  name: string; inject: string[]; apply(environment: { mira: ExtensionContext }, config: C): void | Promise<void>;
} {
  return { name: definition.name, inject: (definition.requires ?? []).map(serviceKey),
    apply: (environment, config) => definition.apply(environment.mira, (config ?? null) as C) };
}
