import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, stat } from 'node:fs/promises';
import { readExtensionConfiguration } from '@mira/extension-host';
import { ExternalAccessError, ExternalAccessStore } from './external-access.ts';

const help = `Mira local external access management (safe JSON metadata only)
pnpm external-access status [--id <sender-id>] [--home <absolute-directory>]
pnpm external-access enable [--home <absolute-directory>]
pnpm external-access disable [--home <absolute-directory>]
pnpm external-access create --id <sender-id> [--home <absolute-directory>]
pnpm external-access rotate --id <sender-id> [--home <absolute-directory>]
pnpm external-access revoke --id <sender-id> [--home <absolute-directory>]

Home defaults to MIRA_HOME or ~/.mira. External access starts disabled.
Existing extensions.json or explicit MIRA_EXTENSIONS is read only to protect the
configured artifact directory; this command never initializes or loads extensions.
create writes a new private credential file; it does not enable external access.
rotate replaces an existing credential, including an explicitly revoked sender.
revoke clears a sender's token; enable/disable controls the global switch.
Changes apply to the next request, without a restart or additional Wake.
Tokens are never accepted as arguments or printed. Trusted clients read the
returned credentialFile privately at runtime. Authentication establishes source,
not approval for actions. Files remain readable by the same OS account.
Writers use an exclusive .access.lock; an orphaned lock is never auto-removed.
After a writer crash, verify no management process remains before removing it.`;

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command || command === '--help') {
    if (arguments_.length) throw new ExternalAccessError('invalid_external_access');
    console.log(help); return;
  }
  if (!['status', 'enable', 'disable', 'create', 'rotate', 'revoke'].includes(command)) throw new ExternalAccessError('invalid_external_access');
  const options = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]; const value = arguments_[index + 1];
    if (!key || !['--home', '--id'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new ExternalAccessError('invalid_external_access');
    options.set(key, value);
  }
  const id = options.get('--id');
  if ((['create', 'rotate', 'revoke'].includes(command) && id === undefined) || (['enable', 'disable'].includes(command) && id !== undefined)) throw new ExternalAccessError('invalid_external_access');
  const miraHome = options.get('--home') ?? path.resolve(process.env['MIRA_HOME'] ?? path.join(os.homedir(), '.mira'));
  const sourceDirectory = fileURLToPath(new URL('../../../', import.meta.url));
  // Validate input before inspecting optional configuration. This read does not
  // initialize the extension host, create a config, or execute extension code.
  if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id)) throw new ExternalAccessError('invalid_external_access');
  new ExternalAccessStore({ miraHome, sourceDirectory });
  const explicitExtensions = process.env['MIRA_EXTENSIONS'];
  const extensionFile = explicitExtensions ?? path.join(miraHome, 'extensions.json');
  let hasExtensions = explicitExtensions !== undefined;
  if (!hasExtensions) {
    try { await lstat(extensionFile); hasExtensions = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let artifactsDirectory: string | undefined;
  if (hasExtensions) {
    if (!(await stat(extensionFile)).isFile()) throw new ExternalAccessError('external_access_unavailable');
    artifactsDirectory = (await readExtensionConfiguration(extensionFile)).artifactsDirectory;
  }
  const store = new ExternalAccessStore({ miraHome, sourceDirectory, ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }) });
  const result = command === 'status' ? await store.status(id)
    : command === 'enable' || command === 'disable' ? await store.setEnabled(command === 'enable')
    : command === 'create' ? await store.create(id!)
    : command === 'rotate' ? await store.rotate(id!) : await store.revoke(id!);
  console.log(JSON.stringify(result, null, 2));
}
try { await main(); }
catch (error) {
  console.error(error instanceof ExternalAccessError ? error.message : 'External access is unavailable; inspect the protected local configuration');
  process.exitCode = 1;
}
