import { useEffect, useRef, useState } from 'react';
import { useRoute } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Copy, Video, VideoOff, Mic, MicOff, X } from 'lucide-react';
import { getPlatformConstraints, initializeQualitySettings, reapplyQualitySettings, requestKeyFrame, setupOptimizedCandidateHandler, type AdaptiveQualityManager } from '@/lib/webrtc-quality';

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

type GameState = {
  version: number;
  data: any;
  gameId: string | null;
};

export default function Host() {
  const [, params] = useRoute('/host/:id');
  const streamId = params?.id || 'default';
  const userId = useRef(String(Math.floor(Math.random() * 1e8))).current;
  
  const { toast } = useToast();
  
  const [isLive, setIsLive] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  
  // Co-host state
  const [cohostQueue, setCohostQueue] = useState<Array<{ userId: string; timestamp: number }>>([]);
  const [activeGuestId, setActiveGuestId] = useState<string | null>(null);
  const [guestMuted, setGuestMuted] = useState(false);
  const [guestCamOff, setGuestCamOff] = useState(false);
  
  // Game state
  const [gameState, setGameState] = useState<GameState>({ version: 0, data: null, gameId: null });
  const [selectedGame, setSelectedGame] = useState<string>('caption_comp');
  
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const guestStreamRef = useRef<MediaStream | null>(null);
  const viewerPcs = useRef<Map<string, RTCPeerConnection>>(new Map());
  const guestPcRef = useRef<RTCPeerConnection | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const qualityManagers = useRef<Map<string, AdaptiveQualityManager>>(new Map());
  const monitoringCleanups = useRef<Map<string, () => void>>(new Map());
  const candidateHandlerCleanups = useRef<Map<string, () => void>>(new Map());

  // WebSocket setup and reconnection
  useEffect(() => {
    if (!isLive) return;
    
    function connect() {
      const ws = new WebSocket(wsUrl('/ws'));
      wsRef.current = ws;
      
      ws.onopen = () => {
        setWsConnected(true);
        reconnectAttemptsRef.current = 0;
        
        // Join as host
        ws.send(JSON.stringify({
          type: 'join_stream',
          streamId,
          role: 'host',
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
      };
      
      ws.onclose = () => {
        setWsConnected(false);
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
        }
        
        // Auto-reconnect with exponential backoff
        if (isLive) {
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
        
        if (msg.type === 'participant_count_update') {
          setViewerCount(msg.count - 1); // Exclude host
        } else if (msg.type === 'joined_stream' && msg.userId) {
          // New viewer joined - create peer connection and send offer
          await createViewerConnection(msg.userId);
        } else if (msg.type === 'webrtc_answer' && msg.fromUserId) {
          const pc = viewerPcs.current.get(msg.fromUserId);
          if (pc && msg.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          }
        } else if (msg.type === 'ice_candidate' && msg.fromUserId) {
          const pc = viewerPcs.current.get(msg.fromUserId) || guestPcRef.current;
          if (pc && msg.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'cohost_request') {
          toast({
            title: 'Co-host Request',
            description: `User ${msg.fromUserId.slice(0, 8)} wants to join`,
          });
        } else if (msg.type === 'cohost_queue_updated') {
          setCohostQueue(msg.queue || []);
        } else if (msg.type === 'cohost_offer' && msg.fromUserId) {
          // Guest is sending offer to host
          await handleGuestOffer(msg.fromUserId, msg.sdp);
        } else if (msg.type === 'cohost_ended') {
          setActiveGuestId(null);
          setGuestMuted(false);
          setGuestCamOff(false);
          guestPcRef.current?.close();
          guestPcRef.current = null;
          guestStreamRef.current = null;
          if (guestVideoRef.current) {
            guestVideoRef.current.srcObject = null;
          }
          
          toast({
            title: 'Co-host Ended',
            description: 'The guest has left the stream',
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
  }, [isLive, streamId, userId]);

  async function createViewerConnection(viewerUserId: string) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    viewerPcs.current.set(viewerUserId, pc);
    
    // Add host tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }
    
    // Add guest tracks if available
    if (guestStreamRef.current) {
      guestStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, guestStreamRef.current!);
      });
    }
    
    // Initialize quality settings (codec prefs, bitrate, audio quality) with monitoring
    if (localStreamRef.current) {
      const { qualityManager, stopMonitoring } = await initializeQualitySettings(pc, localStreamRef.current, 'medium', true);
      qualityManagers.current.set(viewerUserId, qualityManager);
      if (stopMonitoring) {
        monitoringCleanups.current.set(viewerUserId, stopMonitoring);
      }
    }
    
    // Setup optimized ICE candidate handler (stops forwarding after connection established)
    const cleanupCandidateHandler = setupOptimizedCandidateHandler(
      pc,
      (candidate) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'ice_candidate',
            streamId,
            toUserId: viewerUserId,
            candidate: candidate
          }));
        }
      },
      `host→viewer-${viewerUserId.substring(0, 8)}`
    );
    candidateHandlerCleanups.current.set(viewerUserId, cleanupCandidateHandler);
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    wsRef.current?.send(JSON.stringify({
      type: 'webrtc_offer',
      streamId,
      toUserId: viewerUserId,
      sdp: offer,
      metadata: {
        hostStreamId: localStreamRef.current?.id,
        guestStreamId: guestStreamRef.current?.id
      }
    }));
  }

  async function handleGuestOffer(guestUserId: string, sdp: RTCSessionDescriptionInit) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    guestPcRef.current = pc;
    setActiveGuestId(guestUserId);
    
    // Add local tracks to guest connection
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }
    
    // Initialize quality settings for guest connection with monitoring
    if (localStreamRef.current) {
      const { qualityManager, stopMonitoring } = await initializeQualitySettings(pc, localStreamRef.current, 'high', true);
      qualityManagers.current.set('guest', qualityManager);
      if (stopMonitoring) {
        monitoringCleanups.current.set('guest', stopMonitoring);
      }
    }
    
    // Receive guest tracks
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      guestStreamRef.current = stream;
      if (guestVideoRef.current) {
        guestVideoRef.current.srcObject = stream;
      }
      
      // Request keyframe after guest joins for faster first frame
      requestKeyFrame(pc);
      
      // Fan out guest tracks to all viewers
      setTimeout(() => renegotiateAllViewers(), 500);
    };
    
    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'ice_candidate',
          streamId,
          toUserId: guestUserId,
          candidate: event.candidate
        }));
      }
    };
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_answer',
      streamId,
      toUserId: guestUserId,
      sdp: answer
    }));
  }

  async function renegotiateAllViewers() {
    for (const [viewerUserId, pc] of Array.from(viewerPcs.current.entries())) {
      try {
        // Remove all senders and re-add with both host and guest tracks
        const senders = pc.getSenders();
        for (const sender of senders) {
          pc.removeTrack(sender);
        }
        
        // Add host tracks
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(track => {
            pc.addTrack(track, localStreamRef.current!);
          });
        }
        
        // Add guest tracks if available
        if (guestStreamRef.current) {
          guestStreamRef.current.getTracks().forEach(track => {
            pc.addTrack(track, guestStreamRef.current!);
          });
        }
        
        // Reapply quality settings after renegotiation
        const qualityManager = qualityManagers.current.get(viewerUserId);
        if (qualityManager) {
          await reapplyQualitySettings(pc, qualityManager);
        }
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        wsRef.current?.send(JSON.stringify({
          type: 'webrtc_offer',
          streamId,
          toUserId: viewerUserId,
          sdp: offer,
          metadata: {
            hostStreamId: localStreamRef.current?.id,
            guestStreamId: guestStreamRef.current?.id
          }
        }));
      } catch (error) {
        console.error('Renegotiation error:', error);
      }
    }
  }

  async function goLive() {
    try {
      // Use platform-optimized constraints (720p @ 30fps, voice-optimized audio)
      const stream = await navigator.mediaDevices.getUserMedia(getPlatformConstraints());
      
      setLocalStream(stream);
      localStreamRef.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      setIsLive(true);
      
      toast({
        title: 'You\'re Live!',
        description: 'Share the viewer link to invite people',
      });
    } catch (error) {
      toast({
        title: 'Camera Error',
        description: 'Could not access camera/microphone',
        variant: 'destructive',
      });
    }
  }

  function stopLive() {
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    setLocalStream(null);
    setIsLive(false);
    setWsConnected(false);
    
    // Clean up viewer connections
    viewerPcs.current.forEach(pc => pc.close());
    viewerPcs.current.clear();
    
    // Clean up monitoring
    monitoringCleanups.current.forEach(cleanup => cleanup());
    monitoringCleanups.current.clear();
    
    // Clean up candidate handlers
    candidateHandlerCleanups.current.forEach(cleanup => cleanup());
    candidateHandlerCleanups.current.clear();
    
    // Clean up guest connection
    guestPcRef.current?.close();
    guestPcRef.current = null;
  }

  function copyInviteLink() {
    const inviteUrl = `${window.location.origin}/viewer/${streamId}`;
    navigator.clipboard.writeText(inviteUrl);
    toast({
      title: 'Link Copied!',
      description: 'Share this link with viewers',
    });
  }

  function approveCohost(requestUserId: string) {
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_accept',
      streamId,
      userId: requestUserId
    }));
  }

  function declineCohost(requestUserId: string) {
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_decline',
      streamId,
      userId: requestUserId
    }));
  }

  function toggleGuestMute() {
    const newState = !guestMuted;
    setGuestMuted(newState);
    wsRef.current?.send(JSON.stringify({
      type: newState ? 'cohost_mute' : 'cohost_unmute',
      streamId
    }));
  }

  function toggleGuestCam() {
    const newState = !guestCamOff;
    setGuestCamOff(newState);
    wsRef.current?.send(JSON.stringify({
      type: newState ? 'cohost_cam_off' : 'cohost_cam_on',
      streamId
    }));
  }

  function endCohost() {
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_ended',
      streamId,
      by: 'host'
    }));
    setActiveGuestId(null);
  }

  function startGame() {
    const initialState = { round: 1, phase: 'submit', submissions: {} };
    wsRef.current?.send(JSON.stringify({
      type: 'game_init',
      streamId,
      gameId: selectedGame,
      initialState
    }));
    
    toast({
      title: 'Game Started!',
      description: `Playing ${selectedGame}`,
    });
  }

  function nextRound() {
    if (!gameState.data) return;
    
    wsRef.current?.send(JSON.stringify({
      type: 'game_state',
      streamId,
      version: gameState.version + 1,
      full: false,
      patch: {
        round: (gameState.data.round || 1) + 1,
        phase: 'submit',
        submissions: {}
      }
    }));
  }

  function endGame() {
    wsRef.current?.send(JSON.stringify({
      type: 'game_state',
      streamId,
      version: (gameState.version || 0) + 1,
      full: true,
      patch: null
    }));
    
    setGameState({ version: 0, data: null, gameId: null });
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Host Stream</h1>
          <Badge variant={wsConnected ? 'default' : 'secondary'}>
            {wsConnected ? 'Connected' : 'Disconnected'}
          </Badge>
        </div>

        {/* Camera Preview */}
        <Card>
          <CardHeader>
            <CardTitle>Camera Preview</CardTitle>
            <CardDescription>Stream ID: {streamId}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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

            {!isLive ? (
              <Button 
                onClick={goLive} 
                className="w-full"
                data-testid="button-go-live"
              >
                Go Live
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Button 
                    onClick={copyInviteLink} 
                    variant="outline" 
                    className="flex-1"
                    data-testid="button-copy-invite"
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy Invite Link
                  </Button>
                  <Button 
                    onClick={stopLive} 
                    variant="destructive"
                    data-testid="button-stop-live"
                  >
                    Stop
                  </Button>
                </div>
                <div className="text-sm text-center text-muted-foreground">
                  {viewerCount} viewer{viewerCount !== 1 ? 's' : ''} watching
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Co-host Controls */}
        {isLive && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Co-host Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {cohostQueue.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Requests ({cohostQueue.length})</div>
                  {cohostQueue.map((request) => (
                    <div key={request.userId} className="flex items-center justify-between p-2 bg-muted rounded">
                      <span className="text-sm font-mono">{request.userId.slice(0, 8)}</span>
                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          onClick={() => approveCohost(request.userId)}
                          data-testid={`button-approve-${request.userId}`}
                        >
                          Approve
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => declineCohost(request.userId)}
                          data-testid={`button-decline-${request.userId}`}
                        >
                          Decline
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeGuestId && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Active Guest</div>
                  <div className="aspect-video bg-muted rounded-lg overflow-hidden">
                    <video
                      ref={guestVideoRef}
                      autoPlay
                      playsInline
                      className="w-full h-full object-cover"
                      data-testid="video-guest-stream"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={toggleGuestMute}
                      data-testid="button-toggle-guest-mute"
                    >
                      {guestMuted ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={toggleGuestCam}
                      data-testid="button-toggle-guest-cam"
                    >
                      {guestCamOff ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                    </Button>
                    <Button 
                      size="sm" 
                      variant="destructive" 
                      className="flex-1"
                      onClick={endCohost}
                      data-testid="button-end-cohost"
                    >
                      <X className="w-4 h-4 mr-1" />
                      End Co-host
                    </Button>
                  </div>
                </div>
              )}

              {!activeGuestId && cohostQueue.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No co-host requests
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Game Panel */}
        {isLive && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Game Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!gameState.gameId ? (
                <div className="space-y-2">
                  <select 
                    value={selectedGame} 
                    onChange={(e) => setSelectedGame(e.target.value)}
                    className="w-full p-2 border rounded"
                    data-testid="select-game"
                  >
                    <option value="caption_comp">Caption Competition</option>
                    <option value="dont_laugh">Don't Laugh Challenge</option>
                    <option value="image_assoc">Image Association</option>
                  </select>
                  <Button 
                    onClick={startGame} 
                    className="w-full"
                    data-testid="button-start-game"
                  >
                    Start Game
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{selectedGame}</span>
                    <Badge>Round {gameState.data?.round || 1}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Phase: {gameState.data?.phase || 'N/A'} | Version: {gameState.version}
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      size="sm" 
                      onClick={nextRound}
                      data-testid="button-next-round"
                    >
                      Next Round
                    </Button>
                    <Button 
                      size="sm" 
                      variant="destructive" 
                      onClick={endGame}
                      data-testid="button-end-game"
                    >
                      End Game
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
