import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

async function executableFile(file: string): Promise<boolean> {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); }
  catch { return false; }
}

/** Resolve before each new launch so installing system Chrome needs no service restart.
 * Ubuntu's Chrome AppArmor profile applies to the installed executable, not the
 * downloaded cache that upstream discovery otherwise prefers. Probe files only;
 * never retry a failed launch against another browser or import CLI config. */
export async function managedBrowserExecutable(
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
  available: (file: string) => Promise<boolean> = executableFile,
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (platform !== 'linux') return undefined;
  for (const candidate of ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']) {
    if (await available(candidate)) return candidate;
  }
  // Preserve upstream discovery for other installations and platforms.
  return undefined;
}

/** The opener/browser must not inherit provider keys, database URLs or Node
 * injection flags from the credential-bearing local server process. */
export function browserLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'];
  for (const name of names) if (env[name] !== undefined) safe[name] = env[name];
  return safe;
}
