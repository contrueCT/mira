import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentBlob, attachmentKind, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL, validateSelection, uploadAttachment } from '../src/attachments.ts';
import { PENDING_KEY, readPending, writePending } from '../src/timeline.ts';
import type { Attachment } from '../src/types.ts';
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const attachment: Attachment = { id, name: 'hello.txt', mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64) };

test('only safe raster and video types can be embedded; document and active formats stay files', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(attachmentKind(mime), 'image');
  assert.equal(attachmentKind('video/mp4'), 'video');
  for (const mime of ['image/svg+xml', 'text/html', 'application/pdf', 'application/msword', 'image/png;foo=bar']) assert.equal(attachmentKind(mime), 'file');
});
test('selection limits are aggregate and count transient uploading files', () => {
  assert.equal(validateSelection([{ size: 1 }], [{ size: 5 }]), null);
  assert.match(validateSelection([], [{ size: 0 }])!, /空文件/u);
  assert.match(validateSelection([], [{ size: MAX_ATTACHMENT_BYTES + 1 }])!, /50 MB/u);
  assert.match(validateSelection(Array.from({ length: 10 }, () => ({ size: 1 })), [{ size: 1 }])!, /10 个/u);
  assert.match(validateSelection([{ size: MAX_ATTACHMENT_TOTAL }], [{ size: 1 }])!, /100 MB/u);
});
test('attachment-only pending messages recover exact ordered IDs and never binary data', () => {
  let value: string | null = null;
  const storage = { getItem: () => value, setItem: (_: string, raw: string) => { value = raw; }, removeItem: () => { value = null; } };
  const envelope = { id, text: '', occurredAt: '2026-10-13T00:00:00.000Z', attachmentIds: [other, id] };
  writePending(storage, [{ ...envelope, state: 'sending' }]);
  assert.deepEqual(readPending(storage), [{ ...envelope, state: 'uncertain' }]);
  assert.deepEqual(Object.keys(JSON.parse(value!)[0]), ['id', 'text', 'occurredAt', 'attachmentIds', 'state']);
  for (const attachmentIds of [[id, id], ['bad'], [null], 'bad', Array(11).fill(id)]) {
    storage.setItem(PENDING_KEY, JSON.stringify([{ ...envelope, attachmentIds }])); assert.throws(() => readPending(storage));
  }
  storage.setItem(PENDING_KEY, JSON.stringify([{ ...envelope, attachmentIds: [] }])); assert.throws(() => readPending(storage));
});
test('upload and download use protected same-origin fetch and raw bytes', async t => {
  const calls: Array<{ path: string; options: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    return options.method === 'POST' ? Response.json(attachment) : new Response('hello');
  });
  const file = new File(['hello'], 'a & b.txt', { type: 'text/plain' }); const signal = new AbortController().signal;
  assert.deepEqual(await uploadAttachment(file, signal), attachment);
  assert.equal(await (await attachmentBlob(attachment, signal)).text(), 'hello');
  assert.equal(calls[0]!.path, '/api/attachments?name=a%20%26%20b.txt');
  assert.equal(calls[0]!.options.body, file);
  assert.equal(new Headers(calls[0]!.options.headers).get('content-type'), 'application/octet-stream');
  for (const call of calls) { assert.equal(new Headers(call.options.headers).get('x-mira-client'), 'web'); assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.signal, signal); }
});
test('bounded Blob reading rejects overlong and incomplete streams and unreadable errors', async t => {
  const signal = new AbortController().signal;
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('longer than expected'));
  await assert.rejects(attachmentBlob(attachment, signal), /不一致/u);
  mock.mock.mockImplementation(async () => new Response('hi'));
  await assert.rejects(attachmentBlob(attachment, signal), /不完整/u);
  mock.mock.mockImplementation(async () => new Response('hello', { headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } }));
  await assert.rejects(attachmentBlob(attachment, signal), /超出/u);
  mock.mock.mockImplementation(async () => new Response('server error', { status: 500 }));
  await assert.rejects(attachmentBlob(attachment, signal), /500/u);
  const before = mock.mock.callCount();
  await assert.rejects(attachmentBlob({ ...attachment, size: MAX_ATTACHMENT_BYTES + 1 }, signal), /超出/u);
  assert.equal(mock.mock.callCount(), before);
});
test('a published zero-byte file remains downloadable with or without a response body', async t => {
 const empty = {...attachment,size:0};const signal=new AbortController().signal;
 const mock=t.mock.method(globalThis,'fetch',async()=>new Response(''));
 assert.equal((await attachmentBlob(empty,signal)).size,0);
 mock.mock.mockImplementation(async()=>new Response(null));
 assert.equal((await attachmentBlob(empty,signal)).size,0);assert.equal(mock.mock.callCount(),2);
});
