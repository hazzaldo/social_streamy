/**
 * Protocol-aware WebSocket URL builder
 * Works with both HTTP (dev) and HTTPS (production)
 */
export function wsUrl(path = '/ws'): string {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}${path}`;
}
