import type { ApiKeyWrite, CustomConnection } from './types.ts';

export function hasUsableApiKey(credential: ApiKeyWrite | undefined): boolean {
  return !!credential && (typeof credential.apiKey === 'string' ? credential.apiKey.length > 0 : credential.apiKey !== null && credential.hasApiKey);
}

/** Empty input means retain, never replace a saved key with an empty string. */
export function withApiKey<T extends ApiKeyWrite>(credential: T, value: string | null | undefined): T {
  const { apiKey: _previous, ...status } = credential;
  return { ...status, ...(value === '' || value === undefined ? {} : { apiKey: value }) } as T;
}

export function validateApiKey(credential: ApiKeyWrite): void {
  if (typeof credential.apiKey !== 'string') return;
  if (!/^[\x21-\x7e]{1,16384}$/u.test(credential.apiKey)) throw new Error('API Key 不能包含空格或换行，长度不能超过 16384 个字符');
  if (credential.apiKey.includes('sk-ant-oat')) throw new Error('这里需要 API Key，不支持 OAuth 登录凭据');
}

export function sameCredentialTarget(left: CustomConnection, right: CustomConnection): boolean {
  return left.id === right.id && left.baseUrl === right.baseUrl && left.api === right.api && left.modelsUrl === right.modelsUrl;
}
