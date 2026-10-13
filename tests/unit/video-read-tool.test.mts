import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { AttachmentStore, type StoredAttachment } from '../../apps/server/src/attachments.ts';
import { withVideoRead } from '../../apps/server/src/video-read-tool.ts';
const video = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex');
test('explicit native read wrapper snapshots signature-recognized videos, retaining ordinary Pi reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-video-read-'));
  try {
    const store = await AttachmentStore.open(path.join(root, 'store'), []);
    const native = createReadTool(root); const read = withVideoRead(native, store, root);
    assert.deepEqual(read.parameters, native.parameters);
    for (const [name, bytes] of [['empty', Buffer.alloc(0)], ['plain.txt', Buffer.from('first\nsecond\nthird')]] as const) {
      await writeFile(path.join(root, name), bytes);
      assert.deepEqual(await read.execute('read', {path:name}), await native.execute('read', {path:name}));
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(root, 'picture.png'), png);
    assert.deepEqual(await read.execute('image', {path:'picture.png'}), await native.execute('image', {path:'picture.png'}));
    await writeFile(path.join(root, 'data'), video);
    const result = await read.execute('read', {path:'@data'});
    const details = result.details as { version: number; type: string; attachments: StoredAttachment[] };
    assert.equal(details.version, 1); assert.equal(details.type, 'attachment-read');
    assert.equal(details.attachments[0]!.mimeType, 'video/mp4'); assert.equal(details.attachments[0]!.name, 'data');
    assert.doesNotMatch(JSON.stringify(result), /miraNativeVideos|inlineData|"type":"image"/);
    await unlink(path.join(root, 'data'));
    assert.deepEqual(await store.hydrate(details.attachments[0]!), video);
    const uploaded = await store.stage('uploaded.mp4', video);
    const [reference] = await store.resolve([uploaded.id]);
    const uploadedRead = await read.execute('uploaded', {path:reference!.path});
    assert.equal((uploadedRead.details as typeof details).attachments[0]!.mimeType, 'video/mp4');
    await assert.rejects(read.execute('limited', {path:reference!.path,limit:1}), /Video read does not support/);
    await assert.rejects(read.execute('remote', {path:'https://example.test/video.mp4'}));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(read.execute('aborted', {path:reference!.path}, controller.signal));
  } finally { await rm(root, {recursive:true,force:true}); }
});
