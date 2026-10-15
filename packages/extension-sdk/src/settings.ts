/** Declarative protected-settings UI. This is not a sandbox for trusted code. */
export interface ExtensionCredentials {
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export type ExtensionSettingField = { key: string; label: string } & (
  | { type: 'text' | 'secret' | 'boolean' }
  | { type: 'select'; options: Array<{ value: string; label: string }> }
);
export interface ExtensionConnectionStatus {
  state: 'unconfigured' | 'disconnected' | 'connecting' | 'pending' | 'connected' | 'error';
  code?: 'authentication' | 'network' | 'configuration' | 'unknown';
  /** Explicitly public to the protected settings screen, never model metadata. */
  details?: Array<{ label: string; value: string }>;
  authorization?: { url: string; label: string; qr?: boolean };
}
export interface ExtensionSettingsDefinition {
  fields: ExtensionSettingField[];
  actions: Array<{ id: string; label: string; execute(context: { signal: AbortSignal }): Promise<void> }>;
  /** Synchronous, bounded projection. Never return exceptions or credentials. */
  status(): ExtensionConnectionStatus;
}

/** Safe receipt only: never status details, credentials or provider authorization URLs. */
export interface ExtensionSettingsOperation {
  id: string;
  action: string;
  state: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}
/** Bound to the registering installation/activation; retired handles reject every call. */
export interface ExtensionSettingsActions {
  start(actionId: string): Promise<ExtensionSettingsOperation>;
  current(): Promise<ExtensionSettingsOperation | null>;
  cancel(operationId: string): Promise<void>;
}
