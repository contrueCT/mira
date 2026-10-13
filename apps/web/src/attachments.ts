import { ApiError } from './api.ts';
import type { Attachment } from './types.ts';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export function attachmentKind(mimeType: string): 'image' | 'video' | 'file' {
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) return 'image';
  if (['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'].includes(mimeType)) return 'video';
  return 'file';
}
export function attachmentSize(size: number): string { return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`; }
export function validateSelection(current: readonly { size: number }[], incoming: readonly { size: number }[]): string | null {
  if (current.length + incoming.length > MAX_ATTACHMENTS) return '每条消息最多添加 10 个附件';
  if (incoming.some(file => file.size === 0)) return '不能上传空文件';
  if (incoming.some(file => file.size > MAX_ATTACHMENT_BYTES)) return '单个文件不能超过 50 MB，图片不能超过 10 MB';
  if ([...current, ...incoming].reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_TOTAL) return '每条消息的附件总大小不能超过 100 MB';
  return null;
}
async function attachmentResponse(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers); headers.set('X-Mira-Client', 'web');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    let message = `附件请求未完成（${response.status}）`;
    try { const body = await response.json() as { error?: string }; if (typeof body.error === 'string') message = body.error; } catch { /* use bounded public fallback */ }
    throw new ApiError(message, response.status);
  }
  return response;
}
export async function uploadAttachment(file: File, signal: AbortSignal): Promise<Attachment> {
  const response = await attachmentResponse(`/api/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal });
  return await response.json() as Attachment;
}
/** Never put protected API URLs in media elements. Bound streamed bytes before creating a Blob. */
export async function attachmentBlob(attachment: Attachment, signal: AbortSignal): Promise<Blob> {
  const limit = attachmentKind(attachment.mimeType) === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > limit) throw new Error('附件大小超出可读取范围');
  const response = await attachmentResponse(`/api/attachments/${encodeURIComponent(attachment.id)}`, { signal });
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) { await response.body?.cancel(); throw new Error('附件大小超出可读取范围'); }
  const reader = response.body?.getReader();
  if (!reader) { if (attachment.size === 0) return new Blob([], { type: attachment.mimeType }); throw new Error('无法读取附件内容'); }
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit || size > attachment.size) throw new Error('附件大小与记录不一致');
      chunks.push(new Uint8Array(chunk.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (size !== attachment.size) throw new Error('附件下载不完整，请重试');
  return new Blob(chunks, { type: attachment.mimeType });
}
