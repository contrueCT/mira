import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { browserLaunchEnvironment } from '../../apps/server/src/browser-launch.ts';
import { BrowserProcesses } from '../../apps/server/src/browser-processes.ts';

/** Bounds serialized UTF-8 evidence too (control characters expand in JSON). */
export function diagnosticText(value: unknown, limit = 4096): { text: string; truncated: boolean } {
  const original = typeof value === 'string' ? value : String(value ?? '');
  let text = Buffer.from(original).subarray(0, limit).toString('utf8');
  while (Buffer.byteLength(JSON.stringify(text)) > limit) text = text.slice(0, -1);
  return { text, truncated: text !== original };
}
export function startupEvidence(response: Record<string, unknown>): Record<string, unknown> {
  return { success: response.success === true, ...(response.error === undefined ? {} : { error: diagnosticText(response.error) }) };
}

export function startupProbePassed(result: Record<string, unknown>): boolean {
  const launch = result['launch'] as { success?: boolean } | undefined;
  const close = result['close'] as { success?: boolean } | undefined;
  return result['probeError'] === undefined && launch?.success === true && close?.success === true
    && result['ownedBrowserCaptured'] === true && result['cleanup'] === 'confirmed';
}

/** Test-only startup probe. No URL, account, input, server environment or persisted profile. */
export async function probeNativeBrowserLaunch(): Promise<Record<string, unknown>> {
  const executable = process.env['MIRA_AGENT_BROWSER_EXECUTABLE'];
  const chrome = process.env['MIRA_BROWSER_EXECUTABLE_PATH'];
  if (!executable || !chrome) throw Error('Native probe requires explicit official executable paths');
  const home = await mkdtemp(path.join(os.tmpdir(), 'ab-probe-'));
  const session = randomUUID(); const socket = path.join(home, `${session}.sock`);
  const env = browserLaunchEnvironment({ PATH: process.env['PATH'], HOME: home, TMPDIR: home, XDG_CACHE_HOME: home });
  const child = spawn(executable, [], { env: { ...env, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: home, AGENT_BROWSER_PIN_TAB: '1' }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = Buffer.alloc(0); let stderrTruncated = false;
  child.stderr?.on('data', chunk => { const joined = Buffer.concat([stderr, Buffer.from(chunk)]); stderrTruncated ||= joined.length > 8192; stderr = joined.subarray(-8192); });
  let ended = false; child.once('exit', () => { ended = true; owned.retireRoot(); });
  const owned = new BrowserProcesses(child.pid!);
  const result: Record<string, unknown> = {};
  const request = (command: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = randomUUID(); const connection = connect(socket); let buffer = '';
    connection.setTimeout(35_000, () => connection.destroy(Error('Probe native response timeout')));
    connection.on('error', reject); connection.on('connect', () => connection.write(`${JSON.stringify({ ...command, id })}\n`));
    connection.on('data', chunk => {
      buffer += String(chunk); if (buffer.length > 65536) { connection.destroy(Error('Probe response exceeded limit')); return; }
      if (!buffer.includes('\n')) return;
      connection.destroy();
      try { const response = JSON.parse(buffer.split('\n')[0]!) as Record<string, unknown>; if (response.id !== id) throw Error('Probe response identity mismatch'); resolve(response); } catch (error) { reject(error); }
    });
    connection.on('end', () => { if (!buffer.includes('\n')) reject(Error('Probe native response ended')); });
  }).catch(error => { owned.markUnobservableCommand(); throw error; });
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (ended || Date.now() > deadline) throw Error('Probe native daemon did not start');
      try { if ((await lstat(socket)).isSocket()) break; } catch {}
      await delay(25);
    }
    await owned.capture();
    const launch = await request({ action: 'launch', headless: true, engine: 'chrome', pinTab: true, plugins: [], executablePath: chrome });
    // Only the known startup command's result is retained; never a page/input command.
    result['launch'] = startupEvidence(launch);
    try { await owned.capture(true); result['ownedBrowserCaptured'] = true; }
    catch (error) { result['ownedBrowserCaptured'] = false; result['captureError'] = diagnosticText(String(error), 512); }
    if (launch.success === true) result['close'] = startupEvidence(await request({ action: 'close' }));
  } catch (error) { result['probeError'] = diagnosticText(String(error), 512); }
  finally {
    try { await owned.cleanup(); result['cleanup'] = 'confirmed'; } catch (error) { result['cleanup'] = diagnosticText(String(error), 512); child.kill('SIGKILL'); }
    const projected = diagnosticText(stderr.toString('utf8'));
    result['stderr'] = { text: projected.text, truncated: stderrTruncated || projected.truncated };
    await rm(home, { recursive: true, force: true });
  }
  return result;
}
