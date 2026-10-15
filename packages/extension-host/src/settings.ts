import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionConnectionStatus, ExtensionSettingField, ExtensionSettingsDefinition, ExtensionSettingsOperation, Json } from '@mira/extension-sdk';
import { credentialKey, credentialRevision, CredentialConflictError, ExtensionPrivateStorage } from './private-storage.ts';

export interface ExtensionSettingsView {
  revision: string;
  fields: Array<ExtensionSettingField & { value?: string | boolean; configured?: boolean }>;
  actions: Array<{ id: string; label: string; group?: 'primary' | 'secondary' }>;
  status: ExtensionConnectionStatus;
  operation: ExtensionSettingsOperation | null;
}
export interface ExtensionSettingsWrite { expectedRevision: string; values: Record<string, string | boolean>; secrets: Record<string, string | null> }
export class ExtensionSettingsError extends Error {
  readonly code: 'invalid' | 'conflict' | 'unavailable';
  constructor(code: 'invalid' | 'conflict' | 'unavailable') { super(`Extension settings ${code}`); this.code = code; }
}
const invalid = (): never => { throw new ExtensionSettingsError('invalid'); };
const text = (value: unknown, max = 160): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
};
export function validateSettings(definition: ExtensionSettingsDefinition): ExtensionSettingsDefinition {
  if (!Array.isArray(definition.fields) || definition.fields.length > 24 || !Array.isArray(definition.actions) || definition.actions.length > 12 || typeof definition.status !== 'function') invalid();
  const keys = new Set<string>();
  const fields = definition.fields.map(field => {
    credentialKey(field.key); if (keys.has(field.key)) invalid(); keys.add(field.key);
    const base = { key: field.key, label: text(field.label) };
    if (field.type === 'text' || field.type === 'boolean' || field.type === 'secret') return { ...base, type: field.type };
    if (field.type !== 'select' || !Array.isArray(field.options) || !field.options.length || field.options.length > 24) return invalid();
    const values = new Set<string>();
    return { ...base, type: 'select' as const, options: field.options.map(option => { const value = text(option.value); if (values.has(value)) invalid(); values.add(value); return { value, label: text(option.label) }; }) };
  });
  keys.clear();
  const actions = definition.actions.map(action => {
    credentialKey(action.id); if (keys.has(action.id) || typeof action.execute !== 'function') invalid(); keys.add(action.id);
    if (action.group !== undefined && action.group !== 'primary' && action.group !== 'secondary') invalid();
    return { id: action.id, label: text(action.label), ...(action.group === undefined ? {} : { group: action.group }), execute: action.execute.bind(action) };
  });
  return { fields, actions, status: definition.status.bind(definition) };
}
function publicStatus(value: ExtensionConnectionStatus, actions: ExtensionSettingsDefinition['actions']): ExtensionConnectionStatus {
  if (!value || !['unconfigured', 'disconnected', 'connecting', 'pending', 'connected', 'error'].includes(value.state)) return invalid();
  const status: ExtensionConnectionStatus = { state: value.state };
  if (value.visibleActions !== undefined) {
    if (!Array.isArray(value.visibleActions) || value.visibleActions.length > actions.length || new Set(value.visibleActions).size !== value.visibleActions.length || value.visibleActions.some(id => !actions.some(action => action.id === id))) invalid();
    // Declaration order is stable; provider array order is not a UI ordering API.
    status.visibleActions = actions.filter(action => value.visibleActions!.includes(action.id)).map(action => action.id);
  }
  if (value.code !== undefined) { if (!['authentication', 'network', 'configuration', 'unknown'].includes(value.code)) invalid(); status.code = value.code; }
  if (value.details !== undefined) {
    if (!Array.isArray(value.details) || value.details.length > 12) invalid();
    status.details = value.details.map(item => ({ label: text(item.label), value: text(item.value, 1024) }));
  }
  if (value.authorization !== undefined) {
    const url = new URL(text(value.authorization.url, 4096));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalid();
    status.authorization = { url: url.href, label: text(value.authorization.label), qr: value.authorization.qr === true };
  }
  return status;
}
export class RegisteredSettings {
  private operation: ExtensionSettingsView['operation'] = null;
  private admitting = false;
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  readonly definition: ExtensionSettingsDefinition;
  readonly activation: string;
  private readonly owner: string;
  private readonly storage: ExtensionPrivateStorage;
  private readonly config: () => Json;
  private readonly assertActive: () => void;
  private readonly lease: (task: Promise<void>) => void;
  constructor(definition: ExtensionSettingsDefinition, activation: string, owner: string, storage: ExtensionPrivateStorage,
    config: () => Json, assertActive: () => void, lease: (task: Promise<void>) => void) {
    this.definition = definition; this.activation = activation; this.owner = owner; this.storage = storage;
    this.config = config; this.assertActive = assertActive; this.lease = lease;
  }
  async view(): Promise<ExtensionSettingsView> {
    this.assertActive();
    const credentials = await this.storage.values(this.owner); this.assertActive();
    return this.project(credentials);
  }
  private project(credentials: Record<string, string>): ExtensionSettingsView {
    let status: ExtensionConnectionStatus;
    try { status = publicStatus(this.definition.status(), this.definition.actions); } catch { status = { state: 'error', code: 'unknown', visibleActions: [] }; }
    const config = this.config();
    const fields = structuredClone(this.definition.fields).map(field => {
      if (field.type === 'secret') return { ...field, configured: Object.hasOwn(credentials, field.key) };
      const value = config && typeof config === 'object' && !Array.isArray(config) ? config[field.key] : undefined;
      return { ...field, ...(typeof value === 'string' || typeof value === 'boolean' ? { value } : {}) };
    });
    const view = { fields, actions: this.definition.actions.filter(action => status.visibleActions === undefined || status.visibleActions.includes(action.id)).map(({ id, label, group }) => ({ id, label, ...(group === undefined ? {} : { group }) })), status, operation: this.operation ? { ...this.operation } : null };
    // Inspect string leaves rather than JSON syntax (a token such as "true"
    // must not collide with the configured boolean). Keep a usable clear path.
    const privateStrings = Object.values(credentials);
    const encodedSecrets = privateStrings.flatMap(secret => { try { return [encodeURIComponent(secret)]; } catch { return []; } });
    const containsSecret = (value: string): boolean => [...privateStrings, ...encodedSecrets].some(secret => value.includes(secret));
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    if (strings(view.status.details ?? []).some(containsSecret) || (view.status.authorization && strings(view.status.authorization).some(containsSecret))) { view.status = { state: 'error', code: 'unknown', visibleActions: [] }; view.actions = []; }
    for (const field of view.fields) {
      if ('value' in field && typeof field.value === 'string' && containsSecret(field.value)) delete field.value;
      if (containsSecret(field.label)) field.label = '';
      if (field.type === 'select') { field.options = field.options.filter(option => !containsSecret(option.value)); for (const option of field.options) if (containsSecret(option.label)) option.label = ''; }
    }
    for (const action of view.actions) if (containsSecret(action.label)) action.label = '';
    return { revision: createHash('sha256').update(JSON.stringify([this.activation, view, credentials])).digest('hex'), ...structuredClone(view) };
  }
  async check(revision: string, actionId?: string): Promise<string> {
    const credentials = await this.storage.values(this.owner); this.assertActive();
    const view = this.project(credentials);
    if (view.revision !== revision) throw new ExtensionSettingsError('conflict');
    if (actionId !== undefined && !view.actions.some(action => action.id === actionId)) throw new ExtensionSettingsError('unavailable');
    return credentialRevision(credentials);
  }
  private admit(): void {
    this.assertActive();
    if (this.admitting || this.task) throw new ExtensionSettingsError('conflict');
    this.admitting = true;
  }
  async start(actionId: string, revision: string): Promise<ExtensionSettingsView> {
    this.admit();
    try {
      await this.check(revision, actionId);
      const action = this.definition.actions.find(item => item.id === actionId); if (!action) invalid();
      this.assertActive();
      const controller = new AbortController(), id = randomUUID(); this.controller = controller;
      this.operation = { id, action: actionId, state: 'pending' };
      const task = Promise.resolve().then(async () => {
        try { controller.signal.throwIfAborted(); this.assertActive(); await action!.execute({ signal: controller.signal }); this.operation = { id, action: actionId, state: controller.signal.aborted ? 'cancelled' : 'succeeded' }; }
        catch { this.operation = { id, action: actionId, state: controller.signal.aborted ? 'cancelled' : 'failed' }; }
        finally { this.task = null; this.controller = null; }
      });
      this.task = task; this.lease(task);
      return await this.view();
    } finally { this.admitting = false; }
  }
  current(): ExtensionSettingsOperation | null {
    this.assertActive();
    return this.operation ? { id: this.operation.id, action: this.operation.action, state: this.operation.state } : null;
  }
  cancelOperation(operationId: string): void {
    this.assertActive();
    if (!this.operation || this.operation.id !== operationId) throw new ExtensionSettingsError('conflict');
    this.cancel();
  }
  cancel(): void { this.controller?.abort(); }
  async drain(): Promise<void> { this.cancel(); await this.task; }
  async write(input: ExtensionSettingsWrite, apply?: (result: { config: Json; credentialsChanged: boolean }) => Promise<void>): Promise<{ config: Json; credentialsChanged: boolean }> {
    this.admit();
    try {
      const expectedCredentials = await this.check(input.expectedRevision);
      const config = this.config();
      const changesConfig = Object.keys(input.values).length > 0;
      if (changesConfig && config !== null && (typeof config !== 'object' || Array.isArray(config))) invalid();
      const next = { ...(config as Record<string, Json> | null) };
      for (const [key, value] of Object.entries(input.values)) {
        const field = this.definition.fields.find(item => item.key === key);
        if (!field || field.type === 'secret' || (field.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > 4096) || (field.type === 'select' && !field.options.some(item => item.value === value))) invalid();
        Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true });
      }
      for (const key of Object.keys(input.secrets)) if (!this.definition.fields.some(field => field.key === key && field.type === 'secret')) invalid();
      let credentialsChanged: boolean;
      try { credentialsChanged = await this.storage.update(this.owner, input.secrets, this.assertActive, expectedCredentials); }
      catch (error) { if (error instanceof CredentialConflictError) throw new ExtensionSettingsError('conflict'); throw error; }
      const result = { config: changesConfig ? next : structuredClone(config), credentialsChanged };
      await apply?.(result);
      return result;
    } finally { this.admitting = false; }
  }
}
