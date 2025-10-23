import { describe, it, expect, vi } from 'vitest';
import { requestKeyFrame } from '../webrtc-quality';

describe('requestKeyFrame', () => {
  it('invokes requestKeyFrame on receivers if available', () => {
    const recv = { track: { kind: 'video' }, requestKeyFrame: vi.fn() };
    const pc: any = {
      getReceivers: () => [recv],
      getSenders: () => [] // fallback path unused in this case
    };
    requestKeyFrame(pc as RTCPeerConnection);
    expect(recv.requestKeyFrame).toHaveBeenCalled();
  });

  it('is safe if no receivers/senders', () => {
    const pc: any = {
      getReceivers: () => [],
      getSenders: () => []
    };
    expect(() => requestKeyFrame(pc)).not.toThrow();
  });
});
