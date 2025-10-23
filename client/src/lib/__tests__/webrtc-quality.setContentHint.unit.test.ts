import { describe, it, expect } from 'vitest';
import { setContentHint } from '../webrtc-quality';

describe('setContentHint', () => {
  it('sets contentHint for video tracks', () => {
    const track: any = { kind: 'video', contentHint: '' }; // jsdom fake
    setContentHint(track, 'text');
    expect(track.contentHint).toBe('text');
  });

  it('ignores non-video tracks', () => {
    const track: any = { kind: 'audio', contentHint: '' };
    setContentHint(track, 'text');
    expect(track.contentHint).toBe('');
  });
});
