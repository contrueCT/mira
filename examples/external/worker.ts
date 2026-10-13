import { readFile } from 'node:fs/promises';
import { MiraClientError, parseExternalWake } from '@mira/external-sdk';
import { localClient } from './client.ts';

// Run after ordinary software has found a result that needs Mira's attention.
// requestWake already stores its event atomically: do NOT call emitEvent first.
try {
  const file = process.argv[2]; if (!file) throw Error('Missing source envelope');
  const wake = parseExternalWake(JSON.parse(await readFile(file, 'utf8')));
  console.log(JSON.stringify(await localClient().requestWake(wake)));
} catch (error) {
  console.error(error instanceof MiraClientError ? `${error.code}: ${error.outcome}` : 'Invalid source envelope or local configuration');
  process.exitCode = 1;
}
