import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { VideoIcon, WifiIcon, WifiOffIcon, UserIcon, RadioIcon } from 'lucide-react';

function wsUrl(path = '/ws') {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}${path}`;
}

type Role = 'host' | 'viewer' | 'guest';

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
  | { type: 'connection_echo_test'; [k: string]: any }
  | { type: 'pong'; ts: number }
  | { type: 'cohost_request'; fromUserId: string; streamId: string }
  | { type: 'cohost_accepted'; streamId: string }
  | { type: 'cohost_declined'; streamId: string };

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    // TURN servers with TCP/TLS fallback for mobile networks and strict NAT
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

export default function TestHarness() {
  const [role, setRole] = useState<Role>('host');
  const [streamId, setStreamId] = useState<string>('test-stream');
  const [userId, setUserId] = useState<string>(() =>
    String(Math.floor(Math.random() * 1e8))
  );
  const [wsConnected, setWsConnected] = useState(false);
  const [hasLocalTracks, setHasLocalTracks] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const guestStreamRef = useRef<MediaStream | null>(null);
  const hostPcByViewer = useRef<Map<string, RTCPeerConnection>>(new Map());
  const viewerPcRef = useRef<RTCPeerConnection | null>(null);
  const guestPcRef = useRef<RTCPeerConnection | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const viewerHostStreamIdRef = useRef<string | null>(null);
  const viewerGuestStreamIdRef = useRef<string | null>(null);

  const isHost = role === 'host';
  const isGuest = role === 'guest';
  const isViewer = role === 'viewer';

  useEffect(() => {
    console.log('🧪 HARNESS READY', {
      role,
      streamId,
      userId,
      ws: wsUrl('/ws')
    });
  }, [role, streamId, userId]);

  async function ensureLocalTracks() {
    if (localStreamRef.current) return localStreamRef.current;
    const s = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    const roleLabel = isHost ? 'Host' : isGuest ? 'Guest' : 'Viewer';
    s.getTracks().forEach(t => console.log(`${roleLabel}: 🎥 track`, t.kind));
    localStreamRef.current = s;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = s;
      await localVideoRef.current.play().catch(() => {});
    }
    console.log(`${roleLabel}: 🎥 Local tracks ready: ${s.getTracks().length}`);
    setHasLocalTracks(true);
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
      ws.send(
        JSON.stringify({
          type: 'echo',
          message: 'harness-online',
          at: Date.now()
        })
      );
      // Both host and viewer must join the stream
      const join = { type: 'join_stream', streamId, userId };
      console.log(`${isHost ? 'Host' : 'Viewer'}: 📤 join_stream`, join);
      ws.send(JSON.stringify(join));

      // Start heartbeat ping every 25 seconds for mobile network reliability
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      heartbeatIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }
      }, 25000);
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
        case 'pong':
          // Heartbeat response received
          break;
        case 'cohost_request': {
          // Host receives co-host request from a viewer
          if (!isHost) return;
          console.log('🎤 Host: Received co-host request from:', data.fromUserId);
          // Auto-accept for Phase 2 testing. Phase 4 will add UI prompt
          wsRef.current?.send(JSON.stringify({
            type: 'cohost_accept',
            streamId,
            guestUserId: data.fromUserId
          }));
          console.log('✅ Host: Auto-accepted co-host request from:', data.fromUserId);
          break;
        }
        case 'cohost_accepted': {
          // Viewer promoted to Guest
          if (!isGuest && !isViewer) return;
          console.log('🎤 Guest: Co-host request accepted! Becoming Guest...');
          setRole('guest');
          // Guest should now initiate bidirectional connection with Host
          await startGuestOfferToHost();
          break;
        }
        case 'cohost_declined': {
          console.log('❌ Co-host request declined');
          break;
        }
        case 'joined_stream': {
          if (!isHost) return;
          const viewerId = String((data as JoinedStreamMsg).userId ?? '');
          console.log(`Host: 👤 Participant joined stream: ${viewerId}`, 'raw:', data);
          if (!viewerId) {
            console.warn('⚠️ joined_stream missing userId');
            return;
          }
          await startOfferToViewer(viewerId);
          break;
        }
        case 'webrtc_offer': {
          const msg = data as OfferMsg;
          if (isHost) {
            // Host can receive offers from Guest (bidirectional)
            console.log(`Host: 📥 RECEIVED webrtc_offer from ${msg.fromUserId} (likely Guest)`, {
              sdpLen: msg.sdp?.sdp?.length
            });
            await onHostReceiveGuestOffer(msg);
          } else {
            console.log(`Viewer: 📥 RECEIVED webrtc_offer from ${msg.fromUserId}`, {
              sdpLen: msg.sdp?.sdp?.length
            });
            await onViewerReceiveOffer(msg);
          }
          break;
        }
        case 'webrtc_answer': {
          const msg = data as AnswerMsg;
          if (isHost) {
            const pc = hostPcByViewer.current.get(String(msg.fromUserId));
            if (!pc) {
              console.warn('No PC for answer from', msg.fromUserId);
              return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            console.log(
              `Host: ✅ Host setRemoteDescription(answer) for ${msg.fromUserId}`
            );
          } else if (isGuest) {
            // Guest receives answer from Host
            const pc = guestPcRef.current;
            if (!pc) {
              console.warn('No Guest PC for answer');
              return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            console.log(
              `Guest: ✅ Guest setRemoteDescription(answer) from Host`
            );
          }
          break;
        }
        case 'ice_candidate': {
          const msg = data as IceMsg;
          if (isHost) {
            const pc = hostPcByViewer.current.get(String(msg.fromUserId));
            if (pc)
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else if (isGuest) {
            if (guestPcRef.current)
              await guestPcRef.current.addIceCandidate(
                new RTCIceCandidate(msg.candidate)
              );
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
      // Clear heartbeat on close
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
    ws.onerror = e => console.error('WS ERROR', e);
  }

  async function startOfferToViewer(viewerId: string) {
    const local = await ensureLocalTracks();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    hostPcByViewer.current.set(viewerId, pc);

    // Add Host tracks
    local.getTracks().forEach(t => pc.addTrack(t, local));

    // Phase 3: Add Guest tracks if available
    if (guestStreamRef.current) {
      guestStreamRef.current.getTracks().forEach(t => {
        pc.addTrack(t, guestStreamRef.current!);
        console.log(`📤 Host: Adding Guest ${t.kind} track to viewer ${viewerId}`);
      });
    }

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
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await pc.setLocalDescription(offer);
    console.log(`Host: 📤 SENDING webrtc_offer to ${viewerId}`, {
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

    pc.ontrack = ev => {
      console.log(
        '📺 Host received remote track (should be rare in send-only)',
        ev.streams?.[0]
      );
    };
  }

  async function onViewerReceiveOffer(msg: OfferMsg) {
    let pc = viewerPcRef.current;
    if (!pc) {
      pc = new RTCPeerConnection(ICE_CONFIG);
      viewerPcRef.current = pc;
      pc.ontrack = ev => {
        // Phase 3: Viewers receive multiple streams (Host + Guest)
        if (ev.streams.length === 0) {
          console.warn('📺 Viewer received track without stream');
          return;
        }

        const stream = ev.streams[0];
        const streamId = stream.id;
        console.log('📺 Viewer received track:', ev.track.kind, 'from stream:', streamId);
        
        // Track which stream is Host vs Guest by order received
        if (!viewerHostStreamIdRef.current) {
          // First stream = Host
          viewerHostStreamIdRef.current = streamId;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = stream;
            remoteVideoRef.current.play().catch(() => {});
            console.log('📺 Viewer attached Host stream to remoteVideo');
          }
        } else if (viewerHostStreamIdRef.current === streamId) {
          // Additional track from Host stream
          console.log('📺 Viewer received additional Host track');
        } else if (!viewerGuestStreamIdRef.current) {
          // Second stream = Guest
          viewerGuestStreamIdRef.current = streamId;
          if (guestVideoRef.current) {
            guestVideoRef.current.srcObject = stream;
            guestVideoRef.current.play().catch(() => {});
            console.log('📺 Viewer attached Guest stream to guestVideo');
          }
        } else if (viewerGuestStreamIdRef.current === streamId) {
          // Additional track from Guest stream
          console.log('📺 Viewer received additional Guest track');
        }
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
    console.log(`Viewer: 📤 SENDING webrtc_answer to ${msg.fromUserId}`, {
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

  async function onHostReceiveGuestOffer(msg: OfferMsg) {
    // Host receives offer from Guest (bidirectional connection)
    const local = await ensureLocalTracks();
    let pc = hostPcByViewer.current.get(msg.fromUserId);
    
    if (!pc) {
      pc = new RTCPeerConnection(ICE_CONFIG);
      hostPcByViewer.current.set(msg.fromUserId, pc);

      // Host sends tracks to Guest
      local.getTracks().forEach(t => pc!.addTrack(t, local));

      // Host receives tracks from Guest
      pc.ontrack = ev => {
        console.log('📺 Host received track from Guest:', ev.streams[0]);
        // Store Guest stream for fan-out to Viewers (Phase 3)
        guestStreamRef.current = ev.streams[0];
        // Add Guest tracks to all existing viewer connections
        fanOutGuestTracksToViewers();
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

      pc.onconnectionstatechange = () => {
        console.log('🧭 Host-Guest pc state:', pc!.connectionState);
      };
    }

    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`Host: 📤 SENDING webrtc_answer to Guest ${msg.fromUserId}`, {
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

  async function startGuestOfferToHost() {
    // Guest creates bidirectional connection with Host
    const local = await ensureLocalTracks();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    guestPcRef.current = pc;

    // Guest sends their tracks to Host
    local.getTracks().forEach(t => pc.addTrack(t, local));

    // Guest receives tracks from Host
    pc.ontrack = ev => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = ev.streams[0];
        remoteVideoRef.current.play().catch(() => {});
      }
      console.log('📺 Guest attached Host remote stream');
    };

    pc.onicecandidate = ev => {
      if (ev.candidate && wsRef.current) {
        const msg = {
          type: 'ice_candidate',
          toUserId: 'host', // Will be resolved by server
          fromUserId: userId,
          candidate: ev.candidate.toJSON()
        };
        wsRef.current.send(JSON.stringify(msg));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('🧭 Guest pc state:', pc.connectionState);
    };

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await pc.setLocalDescription(offer);
    console.log('Guest: 📤 SENDING webrtc_offer to Host', {
      sdpLen: offer.sdp?.length
    });
    
    // Find host userId from room (server will handle routing)
    wsRef.current?.send(
      JSON.stringify({
        type: 'webrtc_offer',
        toUserId: 'host', // Special identifier - server will find actual host
        fromUserId: userId,
        sdp: offer
      })
    );
  }

  function joinAsViewer() {
    if (!wsRef.current || !wsConnected) return;
    const join = { type: 'join_stream', streamId, userId };
    console.log('📤 join_stream', join);
    wsRef.current.send(JSON.stringify(join));
  }

  async function fanOutGuestTracksToViewers() {
    if (!guestStreamRef.current) return;
    
    console.log('📡 Fan-out: Adding Guest tracks to all viewers and renegotiating');
    
    // Add Guest tracks to all existing viewer peer connections and renegotiate
    for (const [viewerId, pc] of hostPcByViewer.current.entries()) {
      // Check if this PC already has Guest tracks (to avoid duplicates)
      const senders = pc.getSenders();
      const guestTracks = guestStreamRef.current.getTracks();
      
      let tracksAdded = false;
      guestTracks.forEach(track => {
        const existingSender = senders.find(s => s.track?.id === track.id);
        if (!existingSender) {
          pc.addTrack(track, guestStreamRef.current!);
          console.log(`📤 Fan-out: Added Guest ${track.kind} track to viewer ${viewerId}`);
          tracksAdded = true;
        }
      });

      // Renegotiate if we added new tracks
      if (tracksAdded) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`📤 Fan-out: Sending updated offer to viewer ${viewerId}`);
        wsRef.current?.send(
          JSON.stringify({
            type: 'webrtc_offer',
            toUserId: viewerId,
            fromUserId: userId,
            sdp: offer
          })
        );
      }
    }
  }

  function disconnectWS() {
    wsRef.current?.close();
    wsRef.current = null;
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <RadioIcon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight" data-testid="text-title">
                WebRTC Test Harness
              </h1>
              <p className="text-muted-foreground" data-testid="text-subtitle">
                Validate signaling and media flow between Host, Guest, and Viewer
              </p>
            </div>
          </div>
        </div>

        {/* Role Selector & Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserIcon className="h-5 w-5" />
              Configuration
            </CardTitle>
            <CardDescription>Set your role and connection parameters</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Role Selection */}
            <div className="space-y-2">
              <Label>Role</Label>
              <div className="flex gap-2">
                <Button
                  variant={role === 'host' ? 'default' : 'outline'}
                  onClick={() => setRole('host')}
                  className="flex-1"
                  data-testid="button-role-host"
                >
                  Host
                </Button>
                <Button
                  variant={role === 'guest' ? 'default' : 'outline'}
                  onClick={() => setRole('guest')}
                  className="flex-1"
                  data-testid="button-role-guest"
                >
                  Guest
                </Button>
                <Button
                  variant={role === 'viewer' ? 'default' : 'outline'}
                  onClick={() => setRole('viewer')}
                  className="flex-1"
                  data-testid="button-role-viewer"
                >
                  Viewer
                </Button>
              </div>
            </div>

            {/* Stream & User IDs */}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="streamId">Stream ID</Label>
                <Input
                  id="streamId"
                  value={streamId}
                  onChange={(e) => setStreamId(e.target.value)}
                  className="font-mono"
                  data-testid="input-streamid"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="userId">User ID</Label>
                <Input
                  id="userId"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  className="font-mono"
                  data-testid="input-userid"
                />
              </div>
            </div>

            {/* Connection Controls */}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={connectWS}
                disabled={wsConnected}
                variant={wsConnected ? 'secondary' : 'default'}
                data-testid="button-connect-ws"
              >
                <WifiIcon className="mr-2 h-4 w-4" />
                {wsConnected ? 'Connected' : 'Connect WS'}
              </Button>

              {isHost && (
                <Button
                  onClick={ensureLocalTracks}
                  disabled={hasLocalTracks}
                  variant={hasLocalTracks ? 'secondary' : 'default'}
                  data-testid="button-start-media"
                >
                  <VideoIcon className="mr-2 h-4 w-4" />
                  {hasLocalTracks ? 'Media Ready' : 'Start Host Media'}
                </Button>
              )}

              {!isHost && (
                <Button
                  onClick={joinAsViewer}
                  disabled={!wsConnected}
                  data-testid="button-join-viewer"
                >
                  Join as Viewer
                </Button>
              )}

              <Button
                onClick={disconnectWS}
                variant="outline"
                data-testid="button-disconnect"
              >
                <WifiOffIcon className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            </div>

            {/* Connection Status */}
            <div className="flex items-center gap-2">
              <Badge
                variant={wsConnected ? 'default' : 'secondary'}
                className={wsConnected ? 'bg-live' : ''}
                data-testid="badge-ws-status"
              >
                <div className={`mr-2 h-2 w-2 rounded-full ${wsConnected ? 'bg-white animate-pulse-slow' : 'bg-muted-foreground'}`} />
                {wsConnected ? 'WebSocket Connected' : 'WebSocket Disconnected'}
              </Badge>
              {isHost && hasLocalTracks && (
                <Badge variant="default" className="bg-live" data-testid="badge-media-status">
                  <VideoIcon className="mr-1 h-3 w-3" />
                  Media Ready
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Video Grid */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* Local Video (Host Preview) */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Local Preview (Host)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="relative aspect-video bg-black">
                <video
                  ref={localVideoRef}
                  className="h-full w-full object-cover"
                  autoPlay
                  playsInline
                  muted
                  data-testid="video-local"
                />
                {!hasLocalTracks && (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <VideoIcon className="mx-auto h-12 w-12 opacity-50" />
                      <p className="mt-2 text-sm">No local media</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Remote Video (Viewer Sees Host) */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Host Stream</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="relative aspect-video bg-black">
                <video
                  ref={remoteVideoRef}
                  className="h-full w-full object-cover"
                  autoPlay
                  playsInline
                  data-testid="video-remote"
                />
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground pointer-events-none">
                  <div className="text-center">
                    <RadioIcon className="mx-auto h-12 w-12 opacity-50" />
                    <p className="mt-2 text-sm">Waiting for Host stream</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Guest Video (Viewer Sees Guest - Phase 3) */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Guest Stream</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="relative aspect-video bg-black">
                <video
                  ref={guestVideoRef}
                  className="h-full w-full object-cover"
                  autoPlay
                  playsInline
                  data-testid="video-guest"
                />
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground pointer-events-none">
                  <div className="text-center">
                    <UserIcon className="mx-auto h-12 w-12 opacity-50" />
                    <p className="mt-2 text-sm">Waiting for Guest stream</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Debug Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono">Debug Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-xs font-mono text-muted-foreground">
              <div>Role: <span className="text-foreground">{role}</span></div>
              <div>Stream ID: <span className="text-foreground">{streamId}</span></div>
              <div>User ID: <span className="text-foreground">{userId}</span></div>
              <div>WS URL: <span className="text-foreground">{wsUrl('/ws')}</span></div>
              <div>Build: <span className="text-foreground">{new Date().toISOString()}</span></div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
