import { describe, it, expect } from 'vitest';
import { getPreferredCodecs } from '../webrtc-quality';

describe('getPreferredCodecs', () => {
  it('forces H.264 (temporary logic)', () => {
    expect(getPreferredCodecs()).toEqual(['video/H264']);
  });
});
