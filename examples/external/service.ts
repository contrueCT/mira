import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { MiraClientError, parseExternalNotification } from '@mira/external-sdk';
import { localClient } from './client.ts';

// The source file contains { matched: boolean, notification: {id,occurredAt,text} }.
// Polling/filtering is ordinary software. A notice is already-written user-facing
// text, not a request for model judgment. Keep each source revision immutable.
try {
  const file = process.argv[2]; if (!file) throw Error('Missing source file');
  const once = process.argv[3] === '--once'; const client = localClient();
  let delivered: string | undefined;
  for (;;) {
    const source: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('Invalid source');
    const value = source as Record<string, unknown>;
    if (typeof value['matched'] !== 'boolean') throw Error('Invalid source');
    if (value['matched']) {
      const notification = parseExternalNotification(value['notification']);
      const envelope = JSON.stringify(notification);
      if (delivered !== envelope) {
        console.log(JSON.stringify(await client.sendNotification(notification)));
        delivered = envelope;
      }
    }
    if (once) break;
    await setTimeout(30_000);
  }
} catch (error) {
  // Stop on uncertain publication; retain the source file for an explicit exact retry.
  console.error(error instanceof MiraClientError ? `${error.code}: ${error.outcome}` : 'Invalid source envelope or local configuration');
  process.exitCode = 1;
}
