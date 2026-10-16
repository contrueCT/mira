import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryEntry } from '@mira/life';
import { AttachmentStore, AttachmentError, attachmentLimits, attachmentMime, attachmentPublication, createAttachmentTool } from '../../apps/server/src/attachments.ts';
import { createLocalHttp, type WebBackend } from '../../apps/server/src/http.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp('/tmp/mira-attachments-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await AttachmentStore.open(path.join(root, 'store'), [path.join(root, 'source')]) };
}
test('immutable copies survive source deletion, store reopening and original buffer mutation', async t => {
  const { root, store } = await fixture(t); const original = path.join(root, 'hello.txt'); await writeFile(original, 'before');
  const [attachment] = await store.snapshot([original], root); assert.ok(attachment);
  await writeFile(original, 'after'); await rm(original);
  assert.equal((await store.read(attachment.id)).bytes.toString(), 'before');
  const reopened = await AttachmentStore.open(store.directory, []); assert.deepEqual((await reopened.read(attachment.id)).descriptor, (await store.resolve([attachment.id]))[0]);
  const bytes = Buffer.from('first'); const staged = await store.stage('buffer.txt', bytes); bytes.fill(0);
  assert.equal((await store.read(staged.id)).bytes.toString(), 'first');
  const reference = (await store.resolve([attachment.id]))[0]!;
  await assert.rejects(store.hydrate({ ...reference, path: original }), AttachmentError);
  assert.equal(Buffer.from(await store.hydrate(reference)).toString(), 'before');
});
test('resending a verified uploaded path preserves its original filename without trusting other paths', async t => {
  const { root, store } = await fixture(t); const bytes = Buffer.from('%PDF-1.7\nimmutable invoice');
  const uploaded = await store.stage('invoice.pdf', bytes); const [reference] = await store.resolve([uploaded.id]); assert.ok(reference);
  const tool = createAttachmentTool(store, root);
  const result = await tool.execute('resend', { paths: [reference.path] });
  const entry = { id: 'history', kind: 'tool', intent: { toolName: 'send_attachment', callId: 'resend' }, outcome: { callId: 'resend', payload: { role: 'toolResult', toolName: 'send_attachment', toolCallId: 'resend', isError: false, ...result } } } as unknown as HistoryEntry;
  const [resent] = attachmentPublication(entry)!.attachments; assert.ok(resent);
  assert.equal(resent.name, 'invoice.pdf'); assert.equal(resent.mimeType, 'application/pdf'); assert.equal(resent.sha256, uploaded.sha256);
  assert.deepEqual((await store.read(resent.id)).bytes, bytes);
  // A lookalike layout outside this store never supplies display metadata.
  const lookalike = path.join(root, 'other', uploaded.id); await mkdir(lookalike, { recursive: true });
  await writeFile(path.join(lookalike, 'data'), bytes); await writeFile(path.join(lookalike, 'metadata.json'), JSON.stringify(uploaded));
  assert.equal((await store.snapshot([path.join(lookalike, 'data')], root))[0]!.name, 'data');
  await symlink(reference.path, path.join(root, 'alias.pdf'));
  await assert.rejects(store.snapshot([path.join(root, 'alias.pdf')], root), AttachmentError);
  // The owned-path shortcut must retain digest verification, not just its name.
  await chmod(reference.path, 0o600); await writeFile(reference.path, '%PDF-tampered');
  await assert.rejects(tool.execute('resend-tampered', { paths: [reference.path] }), AttachmentError);
});
test('signature MIME never trusts names and files, images and message limits are bounded', async t => {
  const { store } = await fixture(t);
  assert.equal((await store.stage('fake.png', Buffer.from('<svg onload="alert(1)">'))).mimeType, 'application/octet-stream');
  assert.equal(attachmentMime(Buffer.from('%PDF-1.7')), 'application/pdf');
  const bomb = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(bomb); bomb.write('IHDR', 12); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20);
  await assert.rejects(store.stage('bomb.png', bomb), (error: unknown) => error instanceof AttachmentError && error.code === 'too_large');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  assert.equal((await store.stage('pixel.bin', png)).mimeType, 'image/png');
  const image = Buffer.alloc(attachmentLimits.image + 1); Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  await assert.rejects(store.stage('image.bin', image), (error: unknown) => error instanceof AttachmentError && error.code === 'too_large');
  await assert.rejects(store.stage('file.bin', Buffer.alloc(attachmentLimits.file + 1)), AttachmentError);
  const first = await store.stage('file.txt', Buffer.from('x')); await assert.rejects(store.resolve([first.id, first.id]), AttachmentError);
  await assert.rejects(store.resolve(Array.from({ length: 11 }, () => first.id)), AttachmentError);
});
test('opaque ID paths, names, symlink sources/store entries and excluded directories are rejected', async t => {
  const { root, store } = await fixture(t); await writeFile(path.join(root, 'original'), 'safe'); await symlink(path.join(root, 'original'), path.join(root, 'link'));
  await assert.rejects(store.snapshot(['link'], root), AttachmentError); await assert.rejects(store.snapshot(['.'], root), AttachmentError);
  for (const id of ['../original', '/etc/passwd', 'https://example.com', 'not-an-id']) await assert.rejects(store.read(id), AttachmentError);
  for (const name of ['../bad', 'a/b', 'a\\b', 'a\n.txt']) await assert.rejects(store.stage(name, Buffer.alloc(0)), AttachmentError);
  await assert.rejects(AttachmentStore.open(path.join(root, 'source', 'attachments'), [path.join(root, 'source')]), AttachmentError);
  const descriptor = await store.stage('ok', Buffer.from('safe')); const data = path.join(store.directory, descriptor.id, 'data'); await rm(data); await symlink(path.join(root, 'original'), data);
  await assert.rejects(store.read(descriptor.id), AttachmentError);
  await mkdir(path.join(root, 'real')); await symlink(path.join(root, 'real'), path.join(root, 'alias'));
  await assert.rejects(AttachmentStore.open(path.join(root, 'alias', 'store'), []), AttachmentError);
});
test('snapshot hash detects mutation and publication requires a known successful explicit tool outcome', async t => {
  const { root, store } = await fixture(t); await writeFile(path.join(root, 'output.txt'), 'deliverable');
  const tool = createAttachmentTool(store, root); const result = await tool.execute('call', { paths: ['output.txt'], text: 'Here it is' });
  const entry = { id: 'history', kind: 'tool', intent: { toolName: 'send_attachment', callId: 'call' }, outcome: { callId: 'call', payload: { role: 'toolResult', toolName: 'send_attachment', toolCallId: 'call', isError: false, ...result } } } as unknown as HistoryEntry;
  const publication = attachmentPublication(entry); assert.equal(publication?.text, 'Here it is'); assert.equal(publication?.attachments.length, 1);
  assert.ok(!JSON.stringify(publication).includes(root), 'public descriptor must not include immutable server path');
  assert.ok(JSON.stringify(result).includes(store.directory), 'model tool outcome retains immutable path for later file access');
  assert.equal(attachmentPublication({ ...entry, outcome: null } as HistoryEntry), null);
  assert.equal(attachmentPublication({ ...entry, intent: { toolName: 'read', callId: 'call' } } as HistoryEntry), null);
  const descriptor = publication!.attachments[0]!; const file = path.join(store.directory, descriptor.id, 'data'); await chmod(file, 0o600); await writeFile(file, 'tampered');
  await assert.rejects(store.read(descriptor.id), AttachmentError);
});
test('HTTP raw uploads and protected downloads preserve same-origin and path-free allowlists', async t => {
  const { store } = await fixture(t); let submitted: unknown;
  const backend = { uploadAttachment: (name: string, bytes: Uint8Array) => store.stage(name, bytes), readAttachment: (id: string) => store.read(id),
    submit: async (input: unknown) => { submitted = input; return { id: 'message', receipt: 'inserted' as const }; } } as unknown as WebBackend;
  const app = createLocalHttp({ backend, port: 4317 }); t.after(() => app.close());
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-mira-client': 'web', 'content-type': 'application/octet-stream' };
  const url = '/api/attachments?name=%E6%96%87%E4%BB%B6.txt';
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'http://evil.example' }, payload: Buffer.from('hi') })).statusCode, 403);
  const uploaded = await app.inject({ method: 'POST', url, headers, payload: Buffer.from('hi') }); assert.equal(uploaded.statusCode, 201, uploaded.body);
  const descriptor = uploaded.json(); assert.equal(descriptor.name, '文件.txt'); assert.equal(descriptor.path, undefined);
  const downloadUrl = `/api/attachments/${descriptor.id}`;
  assert.equal((await app.inject({ url: downloadUrl, headers: { host: headers.host } })).statusCode, 403);
  assert.equal((await app.inject({ url: downloadUrl, headers: { ...headers, 'sec-fetch-dest': 'image' } })).statusCode, 403);
  const download = await app.inject({ url: downloadUrl, headers }); assert.equal(download.statusCode, 200); assert.equal(download.body, 'hi');
  assert.match(String(download.headers['content-disposition']), /^attachment;/); assert.equal(download.headers['x-content-type-options'], 'nosniff');
  const message = { id: 'message', text: '', occurredAt: '2026-10-13T12:00:00Z', attachmentIds: [descriptor.id] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: { ...headers, 'content-type': 'application/json' }, payload: message })).statusCode, 201); assert.deepEqual(submitted, message);
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: { ...headers, 'content-type': 'application/json' }, payload: { ...message, attachmentIds: [] } })).statusCode, 400);
});
