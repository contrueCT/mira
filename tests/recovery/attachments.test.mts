import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { LocalWebService, WebHttpError } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

async function settled(service: LocalWebService): Promise<void> {
  const end = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > end) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('attachment-only events, immutable envelopes and explicit publications survive PostgreSQL service restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-attachment-recovery-');
  let service: LocalWebService | undefined; let calls = 0;
  try {
    const original = path.join(root, 'generated.txt'); await writeFile(original, 'immutable reply bytes');
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'attachment-recovery', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => { calls++; return calls === 1 ? streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [
        { type: 'toolCall' as const, id: 'publish-files', name: 'send_attachment', arguments: { paths: [original], text: 'Your file' } },
      ] }) : streamOf(assistant('Done')); } };
    service = await LocalWebService.open(options); await settled(service);
    const uploaded = await service.uploadAttachment('input.txt', Buffer.from('user file bytes'));
    const input = { id: 'attachment-message', text: '', occurredAt: '2026-10-13T12:00:00.000Z', attachmentIds: [uploaded.id] };
    assert.equal((await service.submit(input)).receipt, 'inserted'); await settled(service);
    assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 2);
    assert.equal((await service.submit(input)).receipt, 'duplicate');
    await assert.rejects(service.submit({ ...input, text: 'changed' }), (error: unknown) => error instanceof WebHttpError && error.code === 'conflict');
    const another = await service.uploadAttachment('second.txt', Buffer.from('other'));
    await assert.rejects(service.submit({ ...input, attachmentIds: [another.id] }), (error: unknown) => error instanceof WebHttpError && error.code === 'conflict');
    const page = await service.timeline(); const publication = page.items.find(item => item.role === 'assistant' && item.attachments?.length);
    assert.ok(publication); assert.equal(publication.text, 'Your file'); assert.equal(page.items.find(item => item.role === 'user')?.attachments?.[0]?.id, uploaded.id);
    assert.ok(!JSON.stringify(page).includes(root), 'browser projection must not expose server paths');
    const published = publication.attachments![0]!; await writeFile(original, 'changed after send');
    assert.equal((await service.readAttachment(published.id)).bytes.toString(), 'immutable reply bytes');
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service); assert.equal(calls, 2, 'completed publication must not replay');
    const restored = (await service.timeline()).items.filter(item => item.attachments?.length);
    assert.equal(restored.length, 2); assert.equal(restored.find(item => item.role === 'assistant')?.id, publication.id);
    assert.equal((await service.readAttachment(published.id)).bytes.toString(), 'immutable reply bytes');
    assert.equal((await service.submit(input)).receipt, 'duplicate'); assert.equal(calls, 2);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
