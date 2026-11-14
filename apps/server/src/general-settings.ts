import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebHttpError } from './http.ts';

export interface GeneralSettings { revision: number; showExternalMessages: boolean }
export function parseGeneralSettings(value: unknown): GeneralSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebHttpError('invalid_input');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || !Number.isSafeInteger(v['revision']) || (v['revision'] as number) < 0 || typeof v['showExternalMessages'] !== 'boolean') throw new WebHttpError('invalid_input');
  return { revision: v['revision'] as number, showExternalMessages: v['showExternalMessages'] };
}
/** Writes run in the service's single-writer queue; one writer owns this Mira home. */
export class GeneralSettingsStore {
  readonly file: string;
  constructor(file: string) { this.file = file; }
  async read(): Promise<GeneralSettings> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 4096) throw new Error();
        return parseGeneralSettings(JSON.parse(await handle.readFile('utf8')));
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, showExternalMessages: false };
      throw new WebHttpError('unavailable');
    }
  }
  async save(input: unknown): Promise<GeneralSettings> {
    const next = parseGeneralSettings(input); const current = await this.read();
    if (next.revision !== current.revision) throw new WebHttpError('conflict');
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new WebHttpError('unavailable');
    next.revision++;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
      const directory = await open(path.dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return next;
    } finally { await unlink(temp).catch(() => undefined); }
  }
}
