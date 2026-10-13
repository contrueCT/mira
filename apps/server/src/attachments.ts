import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { HistoryEntry } from '@mira/life';

export interface AttachmentDescriptor { id: string; name: string; mimeType: string; size: number; sha256: string }
export interface StoredAttachment extends AttachmentDescriptor { path: string }
export const attachmentLimits = { count: 10, file: 50 * 1024 * 1024, image: 10 * 1024 * 1024, total: 100 * 1024 * 1024 } as const;
export class AttachmentError extends Error {
  readonly code: 'invalid' | 'too_large' | 'unavailable';
  constructor(code: AttachmentError['code']) { super(`Attachment ${code}`); this.code = code; }
}
const invalid = (): never => { throw new AttachmentError('invalid'); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function attachmentDescriptor(value: unknown): AttachmentDescriptor {
  if (!object(value) || typeof value['id'] !== 'string' || !uuid.test(value['id']) || typeof value['name'] !== 'string'
    || !value['name'] || value['name'].length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(value['name'])
    || typeof value['mimeType'] !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value['mimeType'])
    || typeof value['size'] !== 'number' || !Number.isSafeInteger(value['size']) || value['size'] < 0 || value['size'] > attachmentLimits.file
    || typeof value['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['sha256'])) return invalid();
  return { id: value['id'], name: value['name'], mimeType: value['mimeType'], size: value['size'], sha256: value['sha256'] };
}
/** Only byte signatures select browser/model media. Names and upload MIME are untrusted. */
export function attachmentMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes); const starts = (hex: string) => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (starts('89504e470d0a1a0a')) return 'image/png';
  if (starts('ffd8ff')) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.subarray(4, 8).toString() === 'ftyp' && ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(b.subarray(8, 12).toString())) return 'video/mp4';
  if (starts('1a45dfa3') && b.subarray(0, 4096).includes(Buffer.from('webm'))) return 'video/webm';
  if (b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
/** Refuse unreasonable declared raster dimensions without decoding untrusted image data. */
function checkImageDimensions(bytes: Buffer, mime: string): void {
  if (!mime.startsWith('image/')) return;
  let width = 0; let height = 0;
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(12, 16).toString() === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/gif' && bytes.length >= 10) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (mime === 'image/webp') {
    const kind = bytes.subarray(12, 16).toString();
    if (kind === 'VP8X' && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height) invalid();
  if (width > 16_384 || height > 16_384 || width * height > 40_000_000) throw new AttachmentError('too_large');
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
async function noLinks(file: string, allowMissing = false): Promise<void> {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) invalid(); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
async function readRegular(file: string, max: number): Promise<Buffer> {
  await noLinks(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile()) invalid();
    if (before.size > max) throw new AttachmentError('too_large');
    // Bounded reads also protect against a concurrently growing ordinary file.
    const chunks: Buffer[] = []; let size = 0;
    for (;;) { const buffer = Buffer.alloc(Math.min(64 * 1024, max + 1 - size)); const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break; size += bytesRead; if (size > max) throw new AttachmentError('too_large'); chunks.push(buffer.subarray(0, bytesRead)); }
    const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid();
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}
/** Complete snapshots are retained: no age-based deletion can race a durable event/outcome commit. */
export class AttachmentStore {
  readonly directory: string;
  private constructor(directory: string) { this.directory = directory; }
  static async open(directory: string, excluded: string[]): Promise<AttachmentStore> {
    const absolute = path.resolve(directory);
    for (const root of excluded) if (within(path.resolve(root), absolute) || within(absolute, path.resolve(root))) invalid();
    await noLinks(absolute, true);
    await mkdir(absolute, { recursive: true, mode: 0o700 }); await noLinks(absolute);
    const canonical = await realpath(absolute);
    for (const root of excluded) { let resolved: string; try { resolved = await realpath(root); } catch { resolved = path.resolve(root); }
      if (within(resolved, canonical) || within(canonical, resolved)) invalid(); }
    await chmod(canonical, 0o700); return new AttachmentStore(canonical);
  }
  async stage(name: string, input: Uint8Array): Promise<AttachmentDescriptor> {
    const bytes = Buffer.from(input); const mimeType = attachmentMime(bytes);
    if (bytes.length > attachmentLimits.file || (mimeType.startsWith('image/') && bytes.length > attachmentLimits.image)) throw new AttachmentError('too_large');
    checkImageDimensions(bytes, mimeType);
    const descriptor = attachmentDescriptor({ id: randomUUID(), name, mimeType, size: bytes.length, sha256: digest(bytes) });
    await noLinks(this.directory);
    const temporary = path.join(this.directory, `.tmp-${randomUUID()}`); const destination = path.join(this.directory, descriptor.id);
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (const [name, data] of [['data', bytes], ['metadata.json', JSON.stringify(descriptor)]] as const) {
        const file = await open(path.join(temporary, name), 'wx', 0o600);
        try { await file.writeFile(data); await file.sync(); await file.chmod(0o400); } finally { await file.close(); }
      }
      const stagedDirectory = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await stagedDirectory.sync(); } finally { await stagedDirectory.close(); }
      await rename(temporary, destination);
      const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
      return descriptor;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async read(id: string): Promise<{ descriptor: StoredAttachment; bytes: Buffer }> {
    if (!uuid.test(id)) invalid();
    try {
      const directory = path.join(this.directory, id);
      const descriptor = attachmentDescriptor(JSON.parse((await readRegular(path.join(directory, 'metadata.json'), 4096)).toString('utf8')));
      if (descriptor.id !== id) invalid();
      const file = path.join(directory, 'data'); const bytes = await readRegular(file, attachmentLimits.file);
      if (bytes.length !== descriptor.size || digest(bytes) !== descriptor.sha256 || attachmentMime(bytes) !== descriptor.mimeType) invalid();
      return { descriptor: { ...descriptor, path: file }, bytes };
    } catch (error) { if (error instanceof AttachmentError) throw error; throw new AttachmentError('unavailable'); }
  }
  async resolve(ids: string[]): Promise<StoredAttachment[]> {
    if (ids.length > attachmentLimits.count || new Set(ids).size !== ids.length) invalid();
    const result: StoredAttachment[] = []; let size = 0;
    for (const id of ids) { const { descriptor } = await this.read(id); size += descriptor.size; if (size > attachmentLimits.total) throw new AttachmentError('too_large'); result.push(descriptor); }
    return result;
  }
  async hydrate(reference: StoredAttachment): Promise<Uint8Array> {
    const { descriptor, bytes } = await this.read(reference.id);
    if (JSON.stringify(descriptor) !== JSON.stringify({ ...attachmentDescriptor(reference), path: reference.path })) invalid();
    return bytes;
  }
  async snapshot(files: string[], cwd: string): Promise<AttachmentDescriptor[]> {
    if (!files.length || files.length > attachmentLimits.count) invalid();
    const result: AttachmentDescriptor[] = []; let size = 0;
    for (const file of files) {
      const absolute = path.resolve(cwd, file);
      const relative = path.relative(this.directory, absolute).split(path.sep);
      // Only our exact UUID/data layout carries stored display metadata. Verify
      // the full object (including digest and no-symlink checks) before reuse;
      // ordinary local files still get their own basename, not nearby metadata.
      const owned = relative.length === 2 && uuid.test(relative[0]!) && relative[1] === 'data'
        ? await this.read(relative[0]!) : null;
      const bytes = owned?.bytes ?? await readRegular(absolute, attachmentLimits.file); size += bytes.length;
      if (size > attachmentLimits.total) throw new AttachmentError('too_large');
      result.push(await this.stage(owned?.descriptor.name ?? path.basename(absolute), bytes));
    }
    return result;
  }
}
export function createAttachmentTool(store: AttachmentStore, cwd: string): AgentTool {
  return { name: 'send_attachment', label: 'Send attachments', description: 'Publish immutable copies of explicitly selected local regular files to this user in the chat. Use paths to existing files (absolute or relative to the working directory), with optional accompanying text. No URLs, directories or symlinks. Up to 10 files, 50 MiB each (images 10 MiB), 100 MiB total. Only a durably saved successful result appears in chat; ordinary image/tool output is not automatically sent. Select files according to the user request and protect secrets.',
    parameters: Type.Object({ paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 }), text: Type.Optional(Type.String({ maxLength: 65_536 })) }),
    execute: async (_id, raw) => { const args = raw as { paths: string[]; text?: string }; const snapshots = await store.snapshot(args.paths, cwd);
      const attachments = await store.resolve(snapshots.map(item => item.id));
      return { content: [{ type: 'text', text: `Prepared immutable attachment copies for durable publication. These IDs and local paths remain valid after the original files change or disappear.\n${JSON.stringify(attachments)}` }], details: { version: 1, type: 'attachment-publication', attachments, text: args.text ?? '' } }; },
  };
}
export function attachmentPublication(entry: HistoryEntry): { text: string; attachments: AttachmentDescriptor[] } | null {
  if (entry.kind !== 'tool' || entry.intent.toolName !== 'send_attachment' || !entry.outcome || entry.outcome.callId !== entry.intent.callId) return null;
  const payload = entry.outcome.payload;
  if (!object(payload) || payload['role'] !== 'toolResult' || payload['toolName'] !== 'send_attachment' || payload['toolCallId'] !== entry.intent.callId || payload['isError'] !== false || !object(payload['details'])) return null;
  const details = payload['details'];
  if (details['version'] !== 1 || details['type'] !== 'attachment-publication' || typeof details['text'] !== 'string'
    || !Array.isArray(details['attachments']) || !details['attachments'].length || details['attachments'].length > 10) return null;
  try { return { text: details['text'], attachments: details['attachments'].map(attachmentDescriptor) }; } catch { return null; }
}
