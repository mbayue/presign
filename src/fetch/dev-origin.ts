/**
 * Built-in, non-configurable Dev_Origin_Allowlist. Only these exact origins
 * (scheme + host + port) may be contacted over plain HTTP, and only to reach
 * the local Demo_Server.
 */
export const DEV_ORIGIN_ALLOWLIST: readonly string[] = ['http://localhost:8787', 'http://127.0.0.1:8787'];

export function isDevOrigin(url: string | URL): boolean {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    return u.protocol === 'http:' && DEV_ORIGIN_ALLOWLIST.includes(u.origin);
  } catch {
    return false;
  }
}
