export interface AuthStatus { enabled: boolean; authenticated: boolean }
export interface AuthSettings { enabled: boolean; revision: string }
export interface AuthSettingsResult extends AuthStatus { revision: string }

type AuthOperationKind = 'login' | 'settings' | 'logout';
interface AccessSnapshot { epoch: number; status: AuthStatus | null; operation: { id: number; kind: AuthOperationKind } | null }
let snapshot: AccessSnapshot = { epoch: 0, status: null, operation: null };
let operationId = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export const getAccessSnapshot = (): AccessSnapshot => snapshot;
export function subscribeAccess(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function acceptAuthStatus(status: AuthStatus, expectedEpoch = snapshot.epoch): boolean {
  if (snapshot.epoch !== expectedEpoch) return false;
  snapshot = { epoch: snapshot.epoch + 1, status, operation: null };
  notify();
  return true;
}
/** A response from an earlier login must never lock a newly authenticated page. */
export function requireAuthentication(requestEpoch: number): void {
  if (requestEpoch !== snapshot.epoch) return;
  snapshot = { ...snapshot, epoch: snapshot.epoch + 1, status: { enabled: true, authenticated: false } };
  notify();
}
/** Auth writes outlive settings unmount: a rotation may invalidate concurrent reads first. */
export function beginAuthOperation(kind: AuthOperationKind): number {
  const id = ++operationId;
  snapshot = { ...snapshot, operation: { id, kind } };
  notify();
  return id;
}
export function finishAuthOperation(id: number, status?: AuthStatus): boolean {
  if (snapshot.operation?.id !== id) return false;
  snapshot = { epoch: snapshot.epoch + (status ? 1 : 0), status: status ?? snapshot.status, operation: null };
  notify();
  return true;
}
export function parseAuthStatus(value: unknown): AuthStatus {
  if (!value || typeof value !== 'object' || !('enabled' in value) || !('authenticated' in value) || typeof value.enabled !== 'boolean' || typeof value.authenticated !== 'boolean') throw new Error('无法确认访问状态，请重新读取');
  return { enabled: value.enabled, authenticated: value.authenticated };
}
export function parseAuthSettings(value: unknown): AuthSettings {
  if (!value || typeof value !== 'object' || !('enabled' in value) || !('revision' in value) || typeof value.enabled !== 'boolean' || typeof value.revision !== 'string' || !value.revision) throw new Error('无法读取访问设置，请重新读取');
  return { enabled: value.enabled, revision: value.revision };
}
export function validateNewPassword(password: string): void {
  const length = [...password].length;
  if (length < 12 || length > 256 || new TextEncoder().encode(password).byteLength > 1024 || !password.trim()) throw new Error('密码须为 12–256 个字符，不能全部为空白');
}
export const HTTP_WARNING = '密码保护不会加密网络传输。使用 HTTP 时，密码和聊天内容可能被截获；请只在可信网络使用，跨网络访问应先配置 HTTPS。';
