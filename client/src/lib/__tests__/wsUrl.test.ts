import { describe, it, expect } from 'vitest';
import { buildWsUrl } from '../wsUrl';

describe('buildWsUrl', () => {
  it('builds a ws URL with host/port/path', () => {
    const u = buildWsUrl('ws', 'localhost', 5050, '/ws');
    expect(u).toBe('ws://localhost:5050/ws');
  });

  it('supports wss and default port', () => {
    const u = buildWsUrl('wss', 'example.com', undefined, '/api/socket');
    expect(u).toBe('wss://example.com/api/socket');
  });
});
