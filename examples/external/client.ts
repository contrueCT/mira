import { readFile } from 'node:fs/promises';
import { createMiraClient } from '@mira/external-sdk';

/** Node-specific file loading stays in the program, not the platform-neutral SDK.
 * Pass the credentialFile returned by external-access; never paste its contents. */
export function localClient() {
  const file = process.env['MIRA_EXTERNAL_CREDENTIAL_FILE'];
  const baseUrl = process.env['MIRA_EXTERNAL_URL'] ?? 'http://127.0.0.1:3210';
  if (!file) throw Error('Set MIRA_EXTERNAL_CREDENTIAL_FILE to the CLI-returned path');
  return createMiraClient({ baseUrl, credentials: async () => {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Credentials unavailable');
    const entry = value as Record<string, unknown>;
    if (entry['version'] !== 1 || typeof entry['id'] !== 'string' || typeof entry['token'] !== 'string') throw Error('Credentials unavailable');
    return { senderId: entry['id'], token: entry['token'] };
  } });
}
