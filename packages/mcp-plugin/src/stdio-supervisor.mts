/** Small owned-process boundary. MCP bytes stay entirely in the official SDK.
 * Only our spawned POSIX process group is signalled; no process-tree discovery. */
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!command || process.platform === 'win32') process.exit(1);
const environment: NodeJS.ProcessEnv = {};
// The SDK adds its safe default environment to the supervisor. The child gets
// exactly this explicit allowlist plus configured credential values.
const keys: unknown = JSON.parse(process.env['MIRA_MCP_ENV_KEYS'] ?? '[]');
if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) process.exit(1);
for (const key of keys) if (process.env[key] !== undefined) environment[key] = process.env[key];
const child = spawn(command, args, { detached: true, env: environment, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
let closing = false;
let exited = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const signalGroup = (signal: NodeJS.Signals): void => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') process.exitCode = 1; }
};
const close = (): void => {
  if (closing) return; closing = true;
  process.stdin.unpipe(child.stdin); child.stdin.destroy();
  signalGroup('SIGTERM');
  timer = setTimeout(() => { signalGroup('SIGKILL'); if (exited) process.exit(process.exitCode ?? 0); }, 200);
};
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
process.stdin.on('end', close);
process.stdin.on('error', close);
process.stdout.on('error', close);
child.stdin.on('error', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
child.once('error', () => { exited = true; process.exitCode = 1; close(); });
child.once('exit', code => {
  exited = true; process.exitCode = code === 0 || closing ? 0 : 1;
  close();
  // Keep the group escalation timer even when the direct server exits first:
  // grandchildren may still hold pipes or ignore SIGTERM.
  if (!timer) process.exit(process.exitCode);
});
