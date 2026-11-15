/** Safe browser observations, never upstream messages, page content or input. */
export type BrowserFailurePhase = 'dependency' | 'version' | 'preparation' | 'daemon_start' | 'browser_launch' | 'navigation' | 'command' | 'stream' | 'ownership' | 'cleanup';
const descriptions = {
  cli_missing: '未找到 agent-browser 0.39.1。请按 agent-browser skill 在当前 Mira 的 tools/agent-browser 目录安装固定版本，再显式新建浏览器。',
  executable_unavailable: '浏览器控制程序不可执行，请检查显式路径、文件权限和运行平台。',
  version_mismatch: 'agent-browser 版本不符；必须使用固定版本 0.39.1。',
  version_timeout: 'agent-browser 版本检查超时，浏览器尚未启动；请检查原生程序及运行环境。',
  permission_denied: '原生程序或本地浏览器资源被系统权限拒绝，请检查文件权限和系统策略。',
  version_probe_failed: '无法执行 agent-browser 版本检查，请检查原生程序和运行依赖。',
  browser_missing: '未找到可执行的 Chrome/Chromium；请检查安装或 MIRA_BROWSER_EXECUTABLE_PATH。',
  native_dependencies_missing: '原生程序缺少系统动态库或所需运行库版本，请检查系统依赖。',
  sandbox_unavailable: 'Chrome sandbox 无法启动，请检查系统安装和 AppArmor 配置；不要自动禁用 sandbox。',
  unsupported_host: '当前平台不支持受管浏览器所需的 Unix socket。',
  storage_unavailable: '浏览器临时目录不可用，请检查文件权限和磁盘。',
  daemon_start_failed: '浏览器控制 daemon 未能就绪，请检查原生依赖和 Unix socket 支持。',
  launch_failed: 'Chrome/Chromium 启动失败，具体原因尚未识别；请检查浏览器安装及系统依赖。',
  dns_failed: '目标主机名解析失败，请检查地址和服务器 DNS。',
  connection_failed: '目标网页连接失败，请检查目标服务和服务器网络。',
  tls_failed: '目标网页 TLS/证书校验失败，请检查证书和服务器信任配置。',
  timeout: '浏览器操作响应超时；操作可能已发生，请先核对页面状态。',
  transport_failed: '浏览器 daemon 通信失败，无法确认命令结果。',
  invalid_response: '浏览器返回的协议响应不完整、无效或请求 ID 不匹配，无法确认结果。',
  response_limit: '浏览器响应超过大小上限，无法确认完整结果。',
  generation_changed: '浏览器进程或控制代已变化，旧页面引用失效。',
  ownership_unverified: '无法确认浏览器进程所有权；操作及进程清理需要核对。',
  command_failed: '浏览器操作失败，具体原因尚未识别；操作可能已经产生效果。',
  cleanup_failed: '浏览器进程或临时目录清理未能确认，请核对残留状态。',
} as const;
export type BrowserFailureReason = keyof typeof descriptions;
export type BrowserDiagnostic = {
  phase: BrowserFailurePhase; reason: BrowserFailureReason; message: string;
  execution: 'not_started' | 'unknown'; cleanup: 'not_needed' | 'not_attempted' | 'confirmed' | 'unknown';
};
const trusted = new WeakMap<object, Readonly<BrowserDiagnostic>>();
export class BrowserFailure extends Error {
  constructor(phase: BrowserFailurePhase, reason: BrowserFailureReason, execution: BrowserDiagnostic['execution'] = 'unknown', cleanup: BrowserDiagnostic['cleanup'] = 'not_attempted') {
    super(descriptions[reason]); this.name = 'BrowserFailure';
    trusted.set(this, Object.freeze({ phase, reason, message: descriptions[reason], execution, cleanup }));
  }
  static from(error: unknown): Readonly<BrowserDiagnostic> | undefined { return error !== null && typeof error === 'object' ? trusted.get(error) : undefined; }
}
export function browserFailure(error: unknown, phase: BrowserFailurePhase): Readonly<BrowserDiagnostic> {
  return BrowserFailure.from(error) ?? BrowserFailure.from(new BrowserFailure(phase, phase === 'cleanup' ? 'cleanup_failed' : 'command_failed'))!;
}
/** Only inspect fixed native markers. Raw details are neither returned nor persisted. */
export function nativeBrowserReason(value: unknown, fallback: BrowserFailureReason): BrowserFailureReason {
  if (typeof value !== 'string') return fallback;
  const text = value.slice(0, 16_384);
  if (/error while loading shared libraries:|GLIBC_[\d.]+['’]? not found/u.test(text)) return 'native_dependencies_missing';
  if (/No usable sandbox|Failed to move to new namespace|SUID sandbox helper/u.test(text)) return 'sandbox_unavailable';
  if ((fallback === 'daemon_start_failed' || fallback === 'version_probe_failed') && /EACCES|EPERM|Operation not permitted|Permission denied/u.test(text)) return 'permission_denied';
  if (/No browser found|[Bb]rowser executable not found|[Cc]ould not find Chrome|Executable doesn.t exist/u.test(text)) return 'browser_missing';
  if (/net::ERR_NAME_NOT_RESOLVED/u.test(text)) return 'dns_failed';
  if (/net::ERR_CERT_|net::ERR_SSL_/u.test(text)) return 'tls_failed';
  if (/net::ERR_CONNECTION_|net::ERR_PROXY_CONNECTION_FAILED|net::ERR_TUNNEL_CONNECTION_FAILED/u.test(text)) return 'connection_failed';
  if (/net::ERR_TIMED_OUT|[Tt]imed out|[Tt]imeout/u.test(text)) return 'timeout';
  return fallback;
}
