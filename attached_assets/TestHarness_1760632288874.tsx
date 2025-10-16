// File: src/TestHarness.tsx
// Minimal host/viewer WebRTC harness with explicit logs and message shapes.
// Route at /harness. Attach this component in your router.

import React, { useEffect, useMemo, useRef, useState } from 'react';

function wsUrl(path = '/ws') {
  const { protocol, host } = window.location; // e.g., https://<repl>.replit.dev
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}${path}`;
}

type Role = 'host' | 'viewer';

type JoinedStreamMsg = {
  type: 'joined_stream';
  streamId: string;
  userId: string;
};
type OfferMsg = {
  type: 'webrtc_offer';
  fromUserId: string;
  sdp: RTCSessionDescriptionInit;
};
type AnswerMsg = {
  type: 'webrtc_answer';
  fromUserId: string;
  sdp: RTCSessionDescriptionInit;
};
type IceMsg = {
  type: 'ice_candidate';
  fromUserId: string;
  candidate: RTCIceCandidateInit;
};

type ServerMsg =
  | JoinedStreamMsg
  | OfferMsg
  | AnswerMsg
  | IceMsg
  | { type: 'participant_count_update'; streamId: string; count: number }
  | { type: 'connection_echo_test'; [k: string]: any };

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] }
    // TODO: add TURN over TCP/TLS for production
    // { urls: ['turn:TURN_HOST:3478'], username: 'user', credential: 'pass' },
  ]
};

export default function TestHarness() {
  const [role, setRole] = useState<Role>('host');
  const [streamId, setStreamId] = useState<string>('test-stream');
  const [userId, setUserId] = useState<string>(() =>
    String(Math.floor(Math.random() * 1e8))
  );
  const [wsConnected, setWsConnected] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const hostPcByViewer = useRef<Map<string, RTCPeerConnection>>(new Map()); // host only
  const viewerPcRef = useRef<RTCPeerConnection | null>(null); // viewer only

  const isHost = role === 'host';

  useEffect(() => {
    console.log('🧪 HARNESS READY', {
      role,
      streamId,
      userId,
      ws: wsUrl('/ws')
    });
  }, []);

  async function ensureLocalTracks() {
    if (localStreamRef.current) return localStreamRef.current;
    const s = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    s.getTracks().forEach(t => console.log('🎥 track', t.kind));
    localStreamRef.current = s;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = s;
      await localVideoRef.current.play().catch(() => {});
    }
    console.log('🎥 Local tracks ready:', s.getTracks().length);
    return s;
  }

  function connectWS() {
    const url = wsUrl('/ws');
    console.log('🔌 Connecting WS:', url);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      console.log('🎉 WS OPEN');
      // small echo test
      ws.send(
        JSON.stringify({
          type: 'echo',
          message: 'harness-online',
          at: Date.now()
        })
      );
      // viewer auto-joins when WS is open
      if (!isHost) {
        const join = { type: 'join_stream', streamId, userId };
        console.log('📤 join_stream', join);
        ws.send(JSON.stringify(join));
      }
    };

    ws.onmessage = async evt => {
      let data: ServerMsg | any;
      try {
        data = JSON.parse(evt.data);
      } catch (e) {
        console.warn('WS non-JSON message', evt.data);
        return;
      }
      console.log('🛬 WS IN', data);

      switch (data.type) {
        case 'connection_echo_test':
          console.log('🔁 echo ok');
          break;
        case 'joined_stream': {
          if (!isHost) return;
          const viewerId = String((data as JoinedStreamMsg).userId ?? '');
          console.log('👤 Participant joined stream:', viewerId, 'raw:', data);
          if (!viewerId) {
            console.warn('⚠️ joined_stream missing userId');
            return;
          }
          await startOfferToViewer(viewerId);
          break;
        }
        case 'webrtc_offer': {
          if (isHost) return;
          const msg = data as OfferMsg;
          console.log('📥 RECEIVED webrtc_offer', {
            fromUserId: msg.fromUserId,
            sdpLen: msg.sdp?.sdp?.length
          });
          await onViewerReceiveOffer(msg);
          break;
        }
        case 'webrtc_answer': {
          if (!isHost) return;
          const msg = data as AnswerMsg;
          const pc = hostPcByViewer.current.get(String(msg.fromUserId));
          if (!pc) {
            console.warn('No PC for answer from', msg.fromUserId);
            return;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          console.log(
            '✅ Host setRemoteDescription(answer) for',
            msg.fromUserId
          );
          break;
        }
        case 'ice_candidate': {
          const msg = data as IceMsg;
          if (isHost) {
            const pc = hostPcByViewer.current.get(String(msg.fromUserId));
            if (pc)
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            if (viewerPcRef.current)
              await viewerPcRef.current.addIceCandidate(
                new RTCIceCandidate(msg.candidate)
              );
          }
          break;
        }
        default:
          break;
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      console.log('❌ WS CLOSED');
    };
    ws.onerror = e => console.error('WS ERROR', e);
  }

  async function startOfferToViewer(viewerId: string) {
    // Host only
    const local = await ensureLocalTracks();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    hostPcByViewer.current.set(viewerId, pc);

    // add tracks
    local.getTracks().forEach(t => pc.addTrack(t, local));

    pc.onicecandidate = ev => {
      if (ev.candidate && wsRef.current) {
        const msg = {
          type: 'ice_candidate',
          toUserId: viewerId,
          fromUserId: userId,
          candidate: ev.candidate.toJSON()
        };
        wsRef.current.send(JSON.stringify(msg));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('🧭 host pc state', viewerId, pc.connectionState);
    };

    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });
    await pc.setLocalDescription(offer);
    console.log('📤 SENDING webrtc_offer', {
      toUserId: viewerId,
      sdpLen: offer.sdp?.length
    });
    wsRef.current?.send(
      JSON.stringify({
        type: 'webrtc_offer',
        toUserId: viewerId,
        fromUserId: userId,
        sdp: offer
      })
    );

    // Attach remote on host (optional for monitoring)
    pc.ontrack = ev => {
      console.log(
        '📺 Host received remote track (should be rare in send-only)',
        ev.streams?.[0]
      );
    };
  }

  async function onViewerReceiveOffer(msg: OfferMsg) {
    // Viewer only
    let pc = viewerPcRef.current;
    if (!pc) {
      pc = new RTCPeerConnection(ICE_CONFIG);
      viewerPcRef.current = pc;
      pc.ontrack = ev => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = ev.streams[0];
          remoteVideoRef.current.play().catch(() => {});
        }
        console.log('📺 Viewer attached remote stream');
      };
      pc.onicecandidate = ev => {
        if (ev.candidate && wsRef.current) {
          wsRef.current.send(
            JSON.stringify({
              type: 'ice_candidate',
              toUserId: msg.fromUserId,
              fromUserId: userId,
              candidate: ev.candidate.toJSON()
            })
          );
        }
      };
    }
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('📤 SENDING webrtc_answer', {
      toUserId: msg.fromUserId,
      sdpLen: answer.sdp?.length
    });
    wsRef.current?.send(
      JSON.stringify({
        type: 'webrtc_answer',
        toUserId: msg.fromUserId,
        fromUserId: userId,
        sdp: answer
      })
    );
  }

  function joinAsViewer() {
    if (!wsRef.current || !wsConnected) return;
    const join = { type: 'join_stream', streamId, userId };
    console.log('📤 join_stream', join);
    wsRef.current.send(JSON.stringify(join));
  }

  function disconnectWS() {
    wsRef.current?.close();
    wsRef.current = null;
  }

  return (
    <div className='p-6 max-w-3xl mx-auto space-y-4'>
      <h1 className='text-2xl font-bold'>WebRTC Test Harness</h1>
      <p className='opacity-70'>
        Use this to validate signaling and media between a Host and a Viewer.
      </p>

      <div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
        <label className='flex flex-col gap-1'>
          <span className='text-sm'>Role</span>
          <select
            className='border rounded p-2'
            value={role}
            onChange={e => setRole(e.target.value as Role)}
          >
            <option value='host'>Host</option>
            <option value='viewer'>Viewer</option>
          </select>
        </label>
        <label className='flex flex-col gap-1'>
          <span className='text-sm'>streamId</span>
          <input
            className='border rounded p-2'
            value={streamId}
            onChange={e => setStreamId(e.target.value)}
          />
        </label>
        <label className='flex flex-col gap-1'>
          <span className='text-sm'>userId</span>
          <input
            className='border rounded p-2'
            value={userId}
            onChange={e => setUserId(e.target.value)}
          />
        </label>
      </div>

      <div className='flex gap-2 flex-wrap'>
        <button
          className='border rounded px-3 py-2'
          onClick={connectWS}
          disabled={wsConnected}
        >
          Connect WS
        </button>
        {isHost && (
          <button
            className='border rounded px-3 py-2'
            onClick={ensureLocalTracks}
          >
            Start Host Media
          </button>
        )}
        {!isHost && (
          <button className='border rounded px-3 py-2' onClick={joinAsViewer}>
            Join as Viewer
          </button>
        )}
        <button className='border rounded px-3 py-2' onClick={disconnectWS}>
          Disconnect
        </button>
      </div>

      <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
        <div>
          <h3 className='font-semibold'>Local (host preview)</h3>
          <video
            ref={localVideoRef}
            className='w-full bg-black'
            autoPlay
            playsInline
            muted
          ></video>
        </div>
        <div>
          <h3 className='font-semibold'>Remote (viewer sees host)</h3>
          <video
            ref={remoteVideoRef}
            className='w-full bg-black'
            autoPlay
            playsInline
          ></video>
        </div>
      </div>

      <pre className='text-xs opacity-70'>
        Build: {new Date().toISOString()}
      </pre>
    </div>
  );
}

// ---
// File: src/AppHarnessRoute.tsx
// Minimal route injection (if you use React Router, adapt accordingly).

import React from 'react';
import TestHarness from './TestHarness';

export function AppHarnessRoute() {
  return <TestHarness />;
}

// ---
// File: src/main.tsx (snippet to add a route)
// If you already use a router, add a <Route path="/harness" element={<TestHarness/>} />
// For a very simple setup without a router:
// import TestHarness from './TestHarness';
// const root = ReactDOM.createRoot(document.getElementById('root')!);
// root.render(<TestHarness />);

// ---
// Server relay examples (Node/Express + ws), adjust to your server file
// Add these snippets to ensure correct message relaying and joined_stream payload.

/* Example (pseudo):

wss.on('connection', (sock, req) => {
  sock.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch {}
    if (!msg) return;
    switch (msg.type) {
      case 'join_stream': {
        const { streamId, userId } = msg;
        const hostSock = getHostSocket(streamId);
        if (hostSock) hostSock.send(JSON.stringify({ type: 'joined_stream', streamId, userId }));
        break;
      }
      case 'webrtc_offer': {
        const { toUserId } = msg;
        const viewerSock = getViewerSocket(toUserId);
        viewerSock?.send(JSON.stringify({ type: 'webrtc_offer', fromUserId: msg.fromUserId, sdp: msg.sdp }));
        break;
      }
      case 'webrtc_answer': {
        const { toUserId } = msg;
        const hostSock = getHostSocketByUserId(toUserId);
        hostSock?.send(JSON.stringify({ type: 'webrtc_answer', fromUserId: msg.fromUserId, sdp: msg.sdp }));
        break;
      }
      case 'ice_candidate': {
        const { toUserId } = msg;
        const dest = getSocketByUserId(toUserId);
        dest?.send(JSON.stringify({ type: 'ice_candidate', fromUserId: msg.fromUserId, candidate: msg.candidate }));
        break;
      }
    }
  });
});
*/
