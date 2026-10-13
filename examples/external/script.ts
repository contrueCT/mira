import { readFile } from 'node:fs/promises';
import { MiraClientError, parseExternalEvent } from '@mira/external-sdk';
import { localClient } from './client.ts';

// A durable source envelope is the retry input. Never reconstruct ID/time on retry.
try {
  const file = process.argv[2]; if (!file) throw Error('Missing source envelope');
  const event = parseExternalEvent(JSON.parse(await readFile(file, 'utf8')));
  console.log(JSON.stringify(await localClient().emitEvent(event)));
} catch (error) {
  console.error(error instanceof MiraClientError ? `${error.code}: ${error.outcome}` : 'Invalid source envelope or local configuration');
  process.exitCode = 1;
}
