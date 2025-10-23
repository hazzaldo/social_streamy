import { describe, it, expect } from 'vitest';
import { forceH264OnlySDP } from '../webrtc-quality';

const SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 102',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack pli',
  'a=fmtp:96 x-google-start-bitrate=300',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 profile-level-id=42e01f;packetization-mode=1',
  'a=rtcp-fb:102 nack pli'
].join('\r\n');

describe('forceH264OnlySDP', () => {
  it('strips VPx/AV1 and keeps only H.264 payloads in m=video', () => {
    const out = forceH264OnlySDP(SDP);
    // m=video should only list the H.264 PT (102)
    expect(out).toMatch(/^m=video .* 102$/m);
    // VP8 lines should be gone
    expect(out).not.toMatch(/rtpmap:96/);
    // H.264 fmtp/fb should remain
    expect(out).toMatch(/rtpmap:102 H264\/90000/);
    expect(out).toMatch(/fmtp:102 .*profile-level-id=42e01f/);
  });
});
