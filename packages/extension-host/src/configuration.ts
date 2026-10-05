import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LocalExtensionEntry } from './index.ts';

export interface ExtensionConfiguration {
  entries: LocalExtensionEntry[];
  hmr?: boolean;
  configurationFile: string;
  artifactsDirectory?: string;
}
interface Document { entries: LocalExtensionEntry[]; hmr?: boolean; [key: string]: unknown }
function parse(text: string): Document {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Extension configuration must be an object');
  const document = value as Document;
  if (!Array.isArray(document.entries) || (document.hmr !== undefined && typeof document.hmr !== 'boolean')) throw new Error('Extension configuration requires entries[] and optional hmr boolean');
  if (document.entries.some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.path !== 'string' || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean'))) throw new Error('Invalid configured extension entry');
  return document;
}
export async function readExtensionConfiguration(file: string): Promise<ExtensionConfiguration> {
  const configurationFile = await realpath(file);
  const { entries, hmr, artifactsDirectory } = parse(await readFile(configurationFile, 'utf8'));
  if (artifactsDirectory !== undefined && (typeof artifactsDirectory !== 'string' || !path.isAbsolute(artifactsDirectory))) throw new Error('artifactsDirectory must be absolute');
  return { entries: structuredClone(entries), ...(hmr === undefined ? {} : { hmr }), ...(artifactsDirectory === undefined ? {} : { artifactsDirectory: artifactsDirectory as string }), configurationFile };
}
/** One host's serialized writer. External editors do not participate in a lock;
 * the content check detects observed changes, not an atomic filesystem CAS. */
export class ConfigurationWriter {
  private constructor(privateFile: string, text: string, document: Document) { this.file = privateFile; this.text = text; this.document = document; }
  private readonly file: string;
  private text: string;
  private document: Document;
  static async open(file: string, entries: LocalExtensionEntry[], hmr: boolean, artifactsDirectory?: string): Promise<ConfigurationWriter> {
    const canonical = await realpath(file);
    if (!(await stat(canonical)).isFile()) throw new Error('Extension configuration is not a regular file');
    const text = await readFile(canonical, 'utf8');
    const document = parse(text);
    if (!isDeepStrictEqual(document.entries, entries) || (document.hmr ?? false) !== hmr || document['artifactsDirectory'] !== artifactsDirectory) throw new Error('Extension configuration changed since it was loaded; reload it before starting');
    return new ConfigurationWriter(canonical, text, document);
  }
  async replace(id: string, entry: LocalExtensionEntry | null): Promise<void> {
    const next = structuredClone(this.document);
    const index = next.entries.findIndex(item => item.id === id);
    if (entry === null) {
      if (index < 0) throw new Error('Configured extension disappeared');
      next.entries.splice(index, 1);
    } else if (index < 0) next.entries.push(structuredClone(entry));
    else next.entries[index] = { ...next.entries[index], ...structuredClone(entry) };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const temporary = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    try {
      const metadata = await stat(this.file);
      const handle = await open(temporary, 'wx', metadata.mode & 0o777);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (await readFile(this.file, 'utf8') !== this.text) throw new Error('Extension configuration changed externally; reload the host before retrying');
      await rename(temporary, this.file);
      // Publication has occurred. This is a normal atomic file replacement,
      // not a transaction with Cordis activation or an external-editor CAS.
      this.text = text; this.document = next;
    } finally { await rm(temporary, { force: true }); }
  }
}
