// Simple tagged logger (host/viewer can reuse)
export const HLOG = (...a: any[]) => console.log.apply(console, ['🟣', ...a]);
export const HWARN = (...a: any[]) => console.warn.apply(console, ['🟠', ...a]);
export const HERR = (...a: any[]) => console.error.apply(console, ['🔴', ...a]);

// Wrap ws.send so we always see what we try to send
export function hostSend(ws: WebSocket | null, payload: any) {
  const open = ws?.readyState === WebSocket.OPEN;
  try {
    HLOG('WS →', payload?.type, { open }, payload);
    if (open) ws!.send(JSON.stringify(payload));
    else HWARN('WS not OPEN, drop:', payload?.type);
  } catch (e) {
    HERR('WS send error', payload?.type, e);
  }
}

// Attach verbose event logs & a stats poller to a PC
export function attachPcDebug(
  pc: RTCPeerConnection,
  tag: string,
  stopBag?: Map<string, () => void>
) {
  const log = (...a: any[]) => HLOG(`[PC ${tag}]`, ...a);

  pc.onnegotiationneeded = () => log('onnegotiationneeded');
  pc.onsignalingstatechange = () => log('signaling:', pc.signalingState);
  pc.onicegatheringstatechange = () =>
    log('iceGathering:', pc.iceGatheringState);
  pc.oniceconnectionstatechange = () =>
    log('iceConnection:', pc.iceConnectionState);
  pc.onconnectionstatechange = () => log('connection:', pc.connectionState);
  pc.onicecandidateerror = (e: any) =>
    log('iceCandidateError:', e?.errorCode, e?.url);

  pc.ontrack = e => {
    const tracks = e.streams?.[0]
      ?.getTracks()
      ?.map(t => t.kind)
      .join(',');
    log(
      'ontrack:',
      e.track.kind,
      'streams:',
      e.streams.map(s => s.id),
      'streamTracks:',
      tracks
    );
  };

  // 2s getStats poller (inbound/outbound summary)
  const statsId = window.setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let inboundVideo: any,
        inboundAudio: any,
        outboundVideo: any,
        outboundAudio: any;
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && (r as any).kind === 'video')
          inboundVideo = r;
        if (r.type === 'inbound-rtp' && (r as any).kind === 'audio')
          inboundAudio = r;
        if (r.type === 'outbound-rtp' && (r as any).kind === 'video')
          outboundVideo = r;
        if (r.type === 'outbound-rtp' && (r as any).kind === 'audio')
          outboundAudio = r;
      });
      log('stats', {
        inV: inboundVideo
          ? {
              frames: inboundVideo.framesDecoded,
              bytes: inboundVideo.bytesReceived,
              width: inboundVideo.frameWidth,
              height: inboundVideo.frameHeight,
              keyFrames: inboundVideo.keyFramesDecoded
            }
          : null,
        inA: inboundAudio
          ? {
              bytes: inboundAudio.bytesReceived,
              packetsLost: inboundAudio.packetsLost
            }
          : null,
        outV: outboundVideo
          ? {
              frames: outboundVideo.framesEncoded,
              bytes: outboundVideo.bytesSent
            }
          : null,
        outA: outboundAudio ? { bytes: outboundAudio.bytesSent } : null
      });
    } catch (e) {
      HWARN(`[PC ${tag}] stats error`, e);
    }
  }, 2000);

  stopBag?.set(`stats-${tag}`, () => window.clearInterval(statsId));
}
