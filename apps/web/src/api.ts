export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Mira-Client', 'web');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError('服务返回了无法读取的响应', response.status); }
  if (!response.ok) {
    const body = data as { error?: unknown; message?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : `请求未完成（${response.status}）`;
    throw new ApiError(detail, response.status);
  }
  return data as T;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : '暂时无法连接本地服务'; }
export function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
