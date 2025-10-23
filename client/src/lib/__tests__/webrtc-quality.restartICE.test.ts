import { describe, it, expect, vi } from 'vitest';
import { restartICE } from '../webrtc-quality';

describe('restartICE', () => {
  it('creates an offer with iceRestart and sets local description', async () => {
    const createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'x' });
    const setLocalDescription = vi.fn();
    const pc: any = { createOffer, setLocalDescription };
    await restartICE(pc);
    expect(createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(setLocalDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: 'x'
    });
  });
});
