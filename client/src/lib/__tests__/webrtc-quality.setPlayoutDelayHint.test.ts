import { describe, it, expect } from 'vitest';
import { setPlayoutDelayHint } from '../webrtc-quality';

describe('setPlayoutDelayHint', () => {
  it('sets playoutDelayHint when supported', () => {
    const receiver: any = {};
    Object.defineProperty(receiver, 'playoutDelayHint', {
      writable: true,
      value: undefined
    });
    setPlayoutDelayHint(receiver, 0.2);
    expect(receiver.playoutDelayHint).toBe(0.2);
  });

  it('does nothing when unsupported', () => {
    const receiver = Object.freeze({}); // throws if we try to set
    expect(() => setPlayoutDelayHint(receiver as any, 0.2)).not.toThrow();
  });
});
