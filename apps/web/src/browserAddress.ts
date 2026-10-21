const unsupported = '只支持 http 或 https 网址';
/** Trim, default a missing scheme to https, and accept only credential-free http(s) URLs up to 2048 characters. */
export function normalizeBrowserAddress(input: string): { url: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return { error: unsupported };
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (candidate.length > 2048) return { error: unsupported };
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.href.length > 2048) return { error: unsupported };
    return { url: url.href };
  } catch { return { error: unsupported }; }
}
