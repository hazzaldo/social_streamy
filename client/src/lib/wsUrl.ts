/**
 * WebSocket URL utilities
 * - buildWsUrl: pure, testable builder (no window access)
 * - wsUrl: convenience wrapper that derives from window.location
 */

/** Pure builder */
export function buildWsUrl(
  scheme: 'ws' | 'wss',
  host: string,
  port?: number,
  path: string = '/ws'
): string {
  const p = port ? `:${port}` : '';
  return `${scheme}://${host}${p}${path}`;
}

/** Browser-friendly helper (keeps your original API) */
export function wsUrl(path = '/ws'): string {
  const { protocol, hostname, port } = window.location;
  const scheme: 'ws' | 'wss' = protocol === 'https:' ? 'wss' : 'ws';
  const numericPort = port ? Number(port) : undefined;
  return buildWsUrl(scheme, hostname, numericPort, path);
}
