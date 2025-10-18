import { useEffect, useRef, useState } from 'react';
import { useRoute } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Volume2, VolumeX } from 'lucide-react';
import { getPlatformConstraints, initializeQualitySettings, requestKeyFrame } from '@/lib/webrtc-quality';

function wsUrl(path = '/ws') {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}${path}`;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
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

type Role = 'viewer' | 'guest';
type CohostRequestState = 'idle' | 'pending' | 'accepted' | 'declined';

type GameState = {
  version: number;
  data: any;
  gameId: string | null;
};

export default function Viewer() {
  const [, params] = useRoute('/viewer/:id');
  const streamId = params?.id || 'default';
  const userId = useRef(String(Math.floor(Math.random() * 1e8))).current;
  
  const { toast } = useToast();
  
  const [role, setRole] = useState<Role>('viewer');
  const [wsConnected, setWsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [cohostRequestState, setCohostRequestState] = useState<CohostRequestState>('idle');
  const [gameState, setGameState] = useState<GameState>({ version: 0, data: null, gameId: null });
  const [gameInput, setGameInput] = useState('');
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  
  const hostVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const hostPcRef = useRef<RTCPeerConnection | null>(null);
  const guestPcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const roleRef = useRef<Role>('viewer');
  const stopMonitoringRef = useRef<(() => void) | null>(null);

  // Keep roleRef in sync
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  // WebSocket setup
  useEffect(() => {
    if (!isJoined) return;
    
    function connect() {
      const ws = new WebSocket(wsUrl('/ws'));
      wsRef.current = ws;
      
      ws.onopen = () => {
        setWsConnected(true);
        reconnectAttemptsRef.current = 0;
        
        // Join as viewer or guest
        ws.send(JSON.stringify({
          type: 'join_stream',
          streamId,
          role: roleRef.current,
          userId
        }));
        
        // Start heartbeat
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
        }
        heartbeatIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
          }
        }, 25000);
        
        // Sync game state
        if (gameState.gameId) {
          ws.send(JSON.stringify({
            type: 'game_sync',
            streamId
          }));
        }
      };
      
      ws.onclose = () => {
        setWsConnected(false);
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
        }
        
        // Auto-reconnect
        if (isJoined) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          reconnectAttemptsRef.current++;
          
          toast({
            title: 'Reconnecting...',
            description: `Attempting to reconnect in ${delay / 1000}s`,
          });
          
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };
      
      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'webrtc_offer' && msg.fromUserId === 'host') {
          await handleHostOffer(msg.sdp, msg.metadata);
        } else if (msg.type === 'ice_candidate' && msg.fromUserId) {
          const pc = roleRef.current === 'guest' ? guestPcRef.current : hostPcRef.current;
          if (pc && msg.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'cohost_accepted') {
          setCohostRequestState('accepted');
          setRole('guest');
          
          toast({
            title: 'Approved!',
            description: 'You are now a co-host. Starting camera...',
          });
          
          // Upgrade to guest with local media
          await upgradeToGuest();
        } else if (msg.type === 'cohost_declined') {
          setCohostRequestState('declined');
          
          toast({
            title: 'Request Declined',
            description: msg.reason || 'The host declined your request',
            variant: 'destructive',
          });
          
          setTimeout(() => setCohostRequestState('idle'), 3000);
        } else if (msg.type === 'cohost_ended') {
          setRole('viewer');
          setCohostRequestState('idle');
          
          // Stop local tracks
          localStreamRef.current?.getTracks().forEach(track => track.stop());
          localStreamRef.current = null;
          
          // Close guest peer connection
          guestPcRef.current?.close();
          guestPcRef.current = null;
          
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = null;
          }
          
          toast({
            title: 'Co-host Ended',
            description: 'You are back to viewer mode',
          });
        } else if (msg.type === 'cohost_mute' || msg.type === 'cohost_unmute') {
          const shouldMute = msg.type === 'cohost_mute';
          localStreamRef.current?.getAudioTracks().forEach(track => {
            track.enabled = !shouldMute;
          });
          
          toast({
            title: shouldMute ? 'Muted by Host' : 'Unmuted by Host',
          });
        } else if (msg.type === 'cohost_cam_off' || msg.type === 'cohost_cam_on') {
          const shouldDisable = msg.type === 'cohost_cam_off';
          localStreamRef.current?.getVideoTracks().forEach(track => {
            track.enabled = !shouldDisable;
          });
          
          toast({
            title: shouldDisable ? 'Camera Off by Host' : 'Camera On by Host',
          });
        } else if (msg.type === 'game_init' && msg.initialState) {
          setGameState({
            version: 1,
            data: msg.initialState,
            gameId: msg.gameId
          });
          
          toast({
            title: 'Game Started!',
            description: `Playing ${msg.gameId}`,
          });
        } else if (msg.type === 'game_state' && msg.version) {
          setGameState(prev => ({
            version: msg.version,
            data: msg.full ? msg.patch : { ...prev.data, ...msg.patch },
            gameId: prev.gameId
          }));
        }
      };
    }
    
    connect();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [isJoined, streamId, userId]);

  async function handleHostOffer(sdp: RTCSessionDescriptionInit, metadata?: { hostStreamId?: string; guestStreamId?: string }) {
    // Close existing connection if any
    if (hostPcRef.current) {
      hostPcRef.current.close();
    }
    
    const pc = new RTCPeerConnection(ICE_CONFIG);
    hostPcRef.current = pc;
    
    const streamMap = new Map<string, MediaStream>();
    let hostStreamAssigned = false;
    let guestStreamAssigned = false;
    
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      
      // Track unique streams and assign based on explicit stream IDs from metadata
      if (!streamMap.has(stream.id)) {
        streamMap.set(stream.id, stream);
        
        // Use metadata to identify streams if available
        if (metadata?.hostStreamId && stream.id === metadata.hostStreamId && !hostStreamAssigned) {
          if (hostVideoRef.current) {
            hostVideoRef.current.srcObject = stream;
            hostVideoRef.current.play().catch(() => setAutoplayBlocked(true));
            hostStreamAssigned = true;
          }
        } else if (metadata?.guestStreamId && stream.id === metadata.guestStreamId && !guestStreamAssigned) {
          if (guestVideoRef.current) {
            guestVideoRef.current.srcObject = stream;
            guestVideoRef.current.play().catch(() => {});
            guestStreamAssigned = true;
          }
        } else if (!metadata) {
          // Fallback: if no metadata, assign first stream to host, second to guest
          const streamIds = Array.from(streamMap.keys());
          if (streamIds.length === 1 && !hostStreamAssigned) {
            if (hostVideoRef.current) {
              hostVideoRef.current.srcObject = stream;
              hostVideoRef.current.play().catch(() => setAutoplayBlocked(true));
              hostStreamAssigned = true;
            }
          } else if (streamIds.length === 2 && !guestStreamAssigned) {
            if (guestVideoRef.current) {
              guestVideoRef.current.srcObject = stream;
              guestVideoRef.current.play().catch(() => {});
              guestStreamAssigned = true;
            }
          }
        }
      }
    };
    
    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'ice_candidate',
          streamId,
          toUserId: 'host',
          candidate: event.candidate
        }));
      }
    };
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    wsRef.current?.send(JSON.stringify({
      type: 'webrtc_answer',
      streamId,
      toUserId: 'host',
      sdp: answer
    }));
  }

  async function upgradeToGuest() {
    try {
      // Use platform-optimized constraints (720p @ 30fps, voice-optimized audio)
      const stream = await navigator.mediaDevices.getUserMedia(getPlatformConstraints());
      
      localStreamRef.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      // Create peer connection to host
      const pc = new RTCPeerConnection(ICE_CONFIG);
      guestPcRef.current = pc;
      
      // Add local tracks
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });
      
      // Initialize quality settings for guest connection with monitoring
      const { stopMonitoring } = await initializeQualitySettings(pc, stream, 'high', true);
      stopMonitoringRef.current = stopMonitoring;
      
      // Receive host tracks
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (hostVideoRef.current) {
          hostVideoRef.current.srcObject = stream;
        }
        
        // Request keyframe for faster first frame
        requestKeyFrame(pc);
      };
      
      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'ice_candidate',
            streamId,
            toUserId: 'host',
            candidate: event.candidate
          }));
        }
      };
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      wsRef.current?.send(JSON.stringify({
        type: 'cohost_offer',
        streamId,
        toUserId: 'host',
        sdp: offer
      }));
    } catch (error) {
      toast({
        title: 'Camera Error',
        description: 'Could not access camera/microphone',
        variant: 'destructive',
      });
      
      setRole('viewer');
      setCohostRequestState('idle');
    }
  }

  function joinStream() {
    setIsJoined(true);
  }

  function requestCohost() {
    setCohostRequestState('pending');
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_request',
      streamId,
      userId
    }));
    
    toast({
      title: 'Request Sent',
      description: 'Waiting for host approval...',
    });
  }

  function cancelCohostRequest() {
    setCohostRequestState('idle');
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_cancel',
      streamId,
      userId
    }));
  }

  function submitGameInput() {
    if (!gameInput.trim() || !gameState.gameId) return;
    
    wsRef.current?.send(JSON.stringify({
      type: 'game_event',
      streamId,
      eventType: 'player_submission',
      payload: {
        submission: gameInput,
        round: gameState.data?.round || 1
      },
      from: userId
    }));
    
    setGameInput('');
    
    toast({
      title: 'Submitted!',
      description: 'Your answer has been sent',
    });
  }

  function unmute() {
    if (hostVideoRef.current) {
      hostVideoRef.current.muted = false;
      setIsMuted(false);
      setAutoplayBlocked(false);
    }
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Watch Stream</h1>
          <Badge variant={wsConnected ? 'default' : 'secondary'}>
            {wsConnected ? 'Connected' : 'Disconnected'}
          </Badge>
        </div>

        {!isJoined ? (
          <Card>
            <CardHeader>
              <CardTitle>Join Stream</CardTitle>
              <CardDescription>Stream ID: {streamId}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button 
                onClick={joinStream} 
                className="w-full"
                data-testid="button-join-stream"
              >
                Join Stream
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Stream Player */}
            <Card>
              <CardContent className="p-0">
                <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                  <video
                    ref={hostVideoRef}
                    autoPlay
                    playsInline
                    muted={isMuted}
                    className="w-full h-full object-cover"
                    data-testid="video-host-stream"
                  />
                  
                  {/* Guest video (picture-in-picture if present) */}
                  {guestVideoRef.current?.srcObject && (
                    <div className="absolute bottom-4 right-4 w-32 h-32 rounded-lg overflow-hidden border-2 border-white">
                      <video
                        ref={guestVideoRef}
                        autoPlay
                        playsInline
                        className="w-full h-full object-cover"
                        data-testid="video-guest-stream"
                      />
                    </div>
                  )}
                  
                  {/* Autoplay blocked overlay */}
                  {autoplayBlocked && (
                    <div 
                      className="absolute inset-0 bg-black/80 flex items-center justify-center cursor-pointer"
                      onClick={unmute}
                      data-testid="overlay-tap-to-play"
                    >
                      <div className="text-center space-y-2">
                        <Volume2 className="w-12 h-12 mx-auto text-white" />
                        <div className="text-white font-semibold">Tap to Play</div>
                      </div>
                    </div>
                  )}
                  
                  {/* Mute toggle */}
                  {!autoplayBlocked && (
                    <button
                      onClick={() => {
                        if (hostVideoRef.current) {
                          hostVideoRef.current.muted = !isMuted;
                          setIsMuted(!isMuted);
                        }
                      }}
                      className="absolute bottom-4 left-4 p-2 bg-black/50 rounded-full text-white"
                      data-testid="button-toggle-mute"
                    >
                      {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Co-host Controls */}
            {role === 'viewer' && (
              <Card>
                <CardContent className="p-4">
                  {cohostRequestState === 'idle' && (
                    <Button 
                      onClick={requestCohost} 
                      className="w-full"
                      data-testid="button-request-cohost"
                    >
                      Request Co-host
                    </Button>
                  )}
                  {cohostRequestState === 'pending' && (
                    <div className="space-y-2">
                      <div className="text-sm text-center text-muted-foreground">
                        Waiting for host approval...
                      </div>
                      <Button 
                        onClick={cancelCohostRequest} 
                        variant="outline" 
                        className="w-full"
                        data-testid="button-cancel-cohost"
                      >
                        Cancel Request
                      </Button>
                    </div>
                  )}
                  {cohostRequestState === 'declined' && (
                    <div className="text-sm text-center text-destructive">
                      Request declined
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Guest Preview */}
            {role === 'guest' && localStreamRef.current && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Your Camera</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="aspect-video bg-muted rounded-lg overflow-hidden">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                      data-testid="video-local-preview"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Game Input */}
            {gameState.gameId && gameState.data?.phase === 'submit' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{gameState.gameId}</CardTitle>
                  <CardDescription>Round {gameState.data?.round || 1}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Input
                    value={gameInput}
                    onChange={(e) => setGameInput(e.target.value)}
                    placeholder="Enter your caption..."
                    onKeyDown={(e) => e.key === 'Enter' && submitGameInput()}
                    data-testid="input-game-submission"
                  />
                  <Button 
                    onClick={submitGameInput} 
                    disabled={!gameInput.trim()}
                    className="w-full"
                    data-testid="button-submit-game"
                  >
                    Submit
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
