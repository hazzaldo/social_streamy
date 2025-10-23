import { describe, it, expect } from 'vitest';
import { enableOpusFecDtx } from '../webrtc-quality';

const BASE_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=0',
  ''
].join('\r\n');

describe('enableOpusFecDtx', () => {
  it('enables FEC and DTX on opus fmtp line', () => {
    const out = enableOpusFecDtx(BASE_SDP);
    expect(out).toMatch(/useinbandfec=1/);
    expect(out).toMatch(/usedtx=1/);
  });

  it('is idempotent when called twice', () => {
    const once = enableOpusFecDtx(BASE_SDP);
    const twice = enableOpusFecDtx(once);
    expect(twice).toEqual(once);
  });

  it('does nothing if OPUS is not present', () => {
    const sdpNoOpus = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 0',
      ''
    ].join('\r\n');
    const out = enableOpusFecDtx(sdpNoOpus);
    expect(out).toEqual(sdpNoOpus);
  });
});
