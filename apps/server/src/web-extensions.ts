import { randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { readExtensionConfiguration, type ExtensionConfiguration } from '@mira/extension-host';

/** The web app always has a persistent extension host. An explicit configuration
 * remains authoritative; neither invalid nor existing files are repaired here. */
export async function readWebExtensionConfiguration(miraHome: string, explicitFile?: string): Promise<ExtensionConfiguration> {
  if (explicitFile !== undefined) return readExtensionConfiguration(explicitFile);
  const file = path.join(miraHome, 'extensions.json');
  try { return await readExtensionConfiguration(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // Publish a complete file without replacing a concurrent initializer's file.
  // Opening the destination with wx would expose a partially written document.
  const temporary = path.join(miraHome, `.extensions.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ entries: [], artifactsDirectory: path.join(miraHome, 'extension-artifacts') }, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await rm(temporary, { force: true }); }
  return readExtensionConfiguration(file);
}
