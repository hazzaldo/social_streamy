import { describe, it, expect, vi } from 'vitest';
import { hostSend } from '../rtc-debug';

describe('hostSend', () => {
  it('sends JSON when ws is open', () => {
    const send = vi.fn();
    const ws = { readyState: 1, send } as any; // OPEN
    hostSend(ws, { type: 'ping', ts: 123 });
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ping', ts: 123 })
    );
  });

  it('is no-op when ws is missing or not open', () => {
    expect(() => hostSend(null as any, { a: 1 })).not.toThrow();
    const closed = { readyState: 3, send: vi.fn() } as any;
    hostSend(closed, { x: true });
    expect(closed.send).not.toHaveBeenCalled();
  });
});
