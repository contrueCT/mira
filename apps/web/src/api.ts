import { getAccessSnapshot, requireAuthentication } from './auth.ts';
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code) this.code = code;
  }
}
export async function clientFetch(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<Response> {
  const epoch = getAccessSnapshot().epoch;
  const headers = new Headers(options.headers);
  headers.set('X-Mira-Client', 'web');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  // Invalidate before parsing the body, including non-JSON proxy responses.
  if (response.status === 401 && notifyUnauthorized) requireAuthentication(epoch);
  return response;
}
export async function api<T>(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Mira-Client', 'web');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await clientFetch(path, { ...options, headers }, notifyUnauthorized);
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError('服务返回了无法读取的响应', response.status); }
  if (!response.ok) {
    const body = data as { error?: unknown; message?: unknown; code?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
    const code = typeof body?.code === 'string' ? body.code : undefined;
    throw new ApiError(detail, response.status, code);
  }
  return data as T;
}
/** A reader-facing summary in the interface language plus the original
 * technical message (status code, server or browser text) for tracing. */
export interface ErrorInfo { summary: string; detail: string | null }
const localized = /[\u3400-\u9fff]/u;
const statusSummaries: Record<number, string> = {
  400: '请求内容无效', 401: '需要重新登录', 403: '没有权限执行此操作', 404: '请求的内容不存在或已不可用',
  409: '内容已被其他操作更新', 413: '内容超过大小上限', 415: '请求格式不受支持', 429: '请求过于频繁，请稍后再试',
  503: '本地服务暂时不可用，请稍后重试',
};
export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof ApiError) {
    const status = `HTTP ${error.status}`;
    if (localized.test(error.message)) return { summary: error.message, detail: error.status ? status : null };
    const summary = statusSummaries[error.status] ?? (error.status >= 500 ? '本地服务出错了，请稍后重试' : '请求未完成');
    return { summary, detail: error.message ? `${status} · ${error.message}` : status };
  }
  if (isAbort(error)) return { summary: '请求已中断', detail: null };
  // fetch() rejects with a TypeError when the network or local service is unreachable.
  if (error instanceof TypeError) return { summary: '网络连接中断，暂时无法连接本地服务', detail: error.message || null };
  if (error instanceof Error) return localized.test(error.message) || !error.message ? { summary: error.message || '操作未完成', detail: null } : { summary: '操作未完成', detail: error.message };
  return { summary: '暂时无法连接本地服务', detail: null };
}
export function errorText(error: unknown): string { const { summary, detail } = errorInfo(error); return detail ? `${summary}（${detail}）` : summary; }
export function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
