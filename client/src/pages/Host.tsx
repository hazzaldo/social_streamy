import { useEffect, useRef, useState } from 'react';
import { useRoute } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Copy, Video, VideoOff, Mic, MicOff, X } from 'lucide-react';
import { getPlatformConstraints, initializeQualitySettings, reapplyQualitySettings, requestKeyFrame, setupOptimizedCandidateHandler, addVideoTrackWithSimulcast, enableOpusFecDtx, setPlayoutDelayHint, restartICE, setCodecPreferences, forceH264OnlySDP, type AdaptiveQualityManager } from '@/lib/webrtc-quality';

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
  const [isReconnecting, setIsReconnecting] = useState(false);
  
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
  const viewerPlatforms = useRef<Map<string, { isIOSSafari: boolean }>>(new Map());
  
  // Renegotiation queue for glare safety
  const renegotiationInProgress = useRef(false);
  const pendingRenegotiation = useRef(false);
  
  // Connection recovery state (tracks retry attempts per connection)
  const recoveryAttempts = useRef<Map<string, number>>(new Map());
  const recoveryTimeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());
  
  // ICE candidate logging flags (per viewer/guest)
  const haveLoggedFirstIce = useRef<Map<string, boolean>>(new Map());

  // Set build tag for cache-busting verification
  useEffect(() => {
    (window as any).__BUILD_TAG__ = 'WAVE3-H264-MVP';
    console.info('[BUILD]', (window as any).__BUILD_TAG__);
  }, []);

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
          // Store viewer platform info for codec preference
          viewerPlatforms.current.set(msg.userId, { isIOSSafari: msg.isIOSSafari || false });
          // New viewer joined - create peer connection and send offer
          await createViewerConnection(msg.userId);
        } else if (msg.type === 'webrtc_answer' && msg.fromUserId) {
          const pc = viewerPcs.current.get(msg.fromUserId);
          if (pc && msg.sdp) {
            console.log("[HOST] Received webrtc_answer from", msg.fromUserId);
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            
            // Log selected codec after negotiation
            const transceivers = pc.getTransceivers();
            for (const transceiver of transceivers) {
              if (transceiver.currentDirection && transceiver.receiver.track?.kind === 'video') {
                const params = transceiver.sender.getParameters();
                if (params.codecs && params.codecs.length > 0) {
                  const codec = params.codecs[0].mimeType.split('/')[1];
                  const viewerPlatform = viewerPlatforms.current.get(msg.fromUserId);
                  console.log(`✅ Codec selected for viewer ${msg.fromUserId.substring(0, 8)}: ${codec} (isIOSSafari: ${viewerPlatform?.isIOSSafari})`);
                }
                break;
              }
            }
          }
        } else if (msg.type === 'ice_candidate' && msg.fromUserId) {
          const pc = viewerPcs.current.get(msg.fromUserId) || guestPcRef.current;
          if (pc && msg.candidate) {
            // Log first ICE candidate once per connection
            if (!haveLoggedFirstIce.current.get(msg.fromUserId)) {
              console.log("[HOST] First ICE candidate received from", msg.fromUserId);
              haveLoggedFirstIce.current.set(msg.fromUserId, true);
            }
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'cohost_request') {
          console.log("[HOST] cohost_request received from", msg.fromUserId);
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
          
          // Stop quality monitoring for guest
          const guestMonitoring = monitoringCleanups.current.get('guest');
          if (guestMonitoring) {
            guestMonitoring();
            monitoringCleanups.current.delete('guest');
          }
          qualityManagers.current.delete('guest');
          
          // Close guest connection (stop senders first)
          if (guestPcRef.current) {
            guestPcRef.current.getSenders().forEach(sender => {
              if (sender.track) {
                sender.track.stop();
              }
            });
            guestPcRef.current.close();
            guestPcRef.current = null;
          }
          
          // Stop guest stream tracks
          guestStreamRef.current?.getTracks().forEach(track => track.stop());
          guestStreamRef.current = null;
          
          if (guestVideoRef.current) {
            guestVideoRef.current.srcObject = null;
          }
          
          // Renegotiate all viewers to remove guest tracks
          renegotiateAllViewers();
          
          toast({
            title: 'Co-host Ended',
            description: 'The guest has left the stream',
          });
        } else if (msg.type === 'request_keyframe' && msg.fromUserId) {
          // Viewer requesting keyframe (likely NO_FRAMES watchdog triggered)
          console.log(`[HOST] Keyframe request from viewer ${msg.fromUserId.substring(0, 8)}`);
          const pc = viewerPcs.current.get(msg.fromUserId);
          if (pc) {
            const senders = pc.getSenders();
            for (const sender of senders) {
              if (sender.track?.kind === 'video') {
                try {
                  // @ts-ignore - generateKeyFrame is experimental
                  await sender.generateKeyFrame?.();
                  console.log(`[HOST] Generated keyframe for viewer ${msg.fromUserId.substring(0, 8)}`);
                } catch (err) {
                  console.warn(`[HOST] Failed to generate keyframe for viewer ${msg.fromUserId.substring(0, 8)}:`, err);
                }
              }
            }
          }
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

  // Network change handling - trigger recovery on network events
  useEffect(() => {
    if (!isLive) return;
    
    const handleOnline = () => {
      console.log('🌐 Network came online');
      toast({
        title: 'Network Restored',
        description: 'Reconnecting to stream...',
      });
      
      // Trigger recovery for all active connections
      viewerPcs.current.forEach((pc, viewerUserId) => {
        if (pc.connectionState !== 'connected') {
          const qualityManager = qualityManagers.current.get(viewerUserId);
          attemptRecovery(`viewer-${viewerUserId}`, pc, qualityManager);
        }
      });
      
      if (guestPcRef.current && guestPcRef.current.connectionState !== 'connected') {
        const qualityManager = qualityManagers.current.get('guest');
        attemptRecovery('guest', guestPcRef.current, qualityManager);
      }
    };
    
    const handleOffline = () => {
      console.log('🌐 Network went offline');
      setIsReconnecting(true);
    };
    
    const handleNetworkChange = () => {
      console.log('🌐 Network type changed');
      // Trigger ICE restart for all connections when network type changes
      viewerPcs.current.forEach((pc, viewerUserId) => {
        const qualityManager = qualityManagers.current.get(viewerUserId);
        attemptRecovery(`viewer-${viewerUserId}`, pc, qualityManager);
      });
      
      if (guestPcRef.current) {
        const qualityManager = qualityManagers.current.get('guest');
        attemptRecovery('guest', guestPcRef.current, qualityManager);
      }
    };
    
    // Listen for online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Listen for network type changes (if available)
    const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
    if (connection) {
      connection.addEventListener('change', handleNetworkChange);
    }
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connection) {
        connection.removeEventListener('change', handleNetworkChange);
      }
    };
  }, [isLive]);

  /**
   * Attempt connection recovery with exponential backoff (2s, 4s, 8s)
   * Max 3 attempts before giving up
   */
  function attemptRecovery(connectionId: string, pc: RTCPeerConnection, qualityManager?: AdaptiveQualityManager) {
    const attempts = recoveryAttempts.current.get(connectionId) || 0;
    
    // Set reconnecting UI state
    setIsReconnecting(true);
    
    // Clear any pending recovery timeout
    const existingTimeout = recoveryTimeouts.current.get(connectionId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    
    // Max 3 attempts
    if (attempts >= 3) {
      console.log(`❌ Connection recovery failed after 3 attempts: ${connectionId}`);
      recoveryAttempts.current.delete(connectionId);
      recoveryTimeouts.current.delete(connectionId);
      
      // Only clear reconnecting state if no other connections are recovering
      if (recoveryAttempts.current.size === 0) {
        setIsReconnecting(false);
      }
      
      toast({
        title: 'Connection Lost',
        description: `Failed to recover connection for ${connectionId.substring(0, 8)}`,
        variant: 'destructive',
      });
      return;
    }
    
    // Exponential backoff: 2s, 4s, 8s
    const delays = [2000, 4000, 8000];
    const delay = delays[attempts];
    
    console.log(`🔄 Scheduling recovery attempt ${attempts + 1}/3 for ${connectionId} in ${delay}ms`);
    
    const timeout = setTimeout(async () => {
      console.log(`🔄 Attempting recovery ${attempts + 1}/3 for ${connectionId}`);
      
      // Increment attempt counter
      recoveryAttempts.current.set(connectionId, attempts + 1);
      
      // Trigger ICE restart
      await restartICE(pc, qualityManager);
      
      toast({
        title: 'Reconnecting...',
        description: `Attempt ${attempts + 1} of 3`,
      });
    }, delay);
    
    recoveryTimeouts.current.set(connectionId, timeout);
  }
  
  /**
   * Clear recovery state when connection succeeds
   */
  function clearRecoveryState(connectionId: string) {
    const existingTimeout = recoveryTimeouts.current.get(connectionId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    recoveryAttempts.current.delete(connectionId);
    recoveryTimeouts.current.delete(connectionId);
    
    // Clear reconnecting UI state if no other connections are recovering
    if (recoveryAttempts.current.size === 0) {
      setIsReconnecting(false);
    }
  }

  async function createViewerConnection(viewerUserId: string) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    viewerPcs.current.set(viewerUserId, pc);
    
    // Add host tracks (use simulcast for video)
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        if (track.kind === 'video') {
          await addVideoTrackWithSimulcast(pc, track, localStreamRef.current);
        } else {
          pc.addTrack(track, localStreamRef.current);
        }
      }
    }
    
    // Add guest tracks if available (use simulcast for video)
    if (guestStreamRef.current) {
      for (const track of guestStreamRef.current.getTracks()) {
        if (track.kind === 'video') {
          await addVideoTrackWithSimulcast(pc, track, guestStreamRef.current);
        } else {
          pc.addTrack(track, guestStreamRef.current);
        }
      }
    }
    
    // Force H.264 for ALL viewers (debug mode)
    console.log(`[HOST] Forcing H.264 for viewer ${viewerUserId.substring(0, 8)}`);
    
    // Try setCodecPreferences first
    let h264Forced = false;
    const transceivers = pc.getTransceivers();
    for (const transceiver of transceivers) {
      if (transceiver.sender.track?.kind === 'video' && transceiver.setCodecPreferences) {
        try {
          const capabilities = RTCRtpSender.getCapabilities?.('video');
          if (capabilities && capabilities.codecs) {
            const h264Codecs = capabilities.codecs.filter(codec =>
              codec.mimeType.toLowerCase() === 'video/h264'
            );
            if (h264Codecs.length > 0) {
              transceiver.setCodecPreferences(h264Codecs);
              h264Forced = true;
              console.log(`[HOST] Forced H.264 via setCodecPreferences for viewer ${viewerUserId.substring(0, 8)}`);
            }
          }
        } catch (err) {
          console.warn(`[HOST] setCodecPreferences failed for viewer ${viewerUserId.substring(0, 8)}, will use SDP munging:`, err);
        }
      }
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
    // Enable OPUS FEC/DTX for audio resilience
    if (offer.sdp) {
      offer.sdp = enableOpusFecDtx(offer.sdp);
      // Apply SDP munging only if setCodecPreferences failed
      if (!h264Forced) {
        offer.sdp = forceH264OnlySDP(offer.sdp);
        console.log(`[HOST] Forced H.264 via SDP munging for viewer ${viewerUserId.substring(0, 8)}`);
      }
    }
    await pc.setLocalDescription(offer);
    console.log(`[HOST] offer → viewer ${viewerUserId.substring(0, 8)} (h264-only=${h264Forced || !!offer.sdp})`);
    
    // Request keyframe for faster first frame on viewer join
    // Also handle ICE failures with restart
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        // Connection succeeded - clear recovery state and request keyframe
        clearRecoveryState(`viewer-${viewerUserId}`);
        requestKeyFrame(pc);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // Connection failed - attempt recovery with exponential backoff (2s, 4s, 8s)
        const qualityManager = qualityManagers.current.get(viewerUserId);
        attemptRecovery(`viewer-${viewerUserId}`, pc, qualityManager);
      }
    };
    
    // Monitor ICE connection state for transport stability
    pc.oniceconnectionstatechange = () => {
      const qualityManager = qualityManagers.current.get(viewerUserId);
      
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        // Pause downshifts for transport stability
        if (qualityManager) {
          qualityManager.pauseDownshifts(5000);
        }
      }
    };
    
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
    
    // Keyframe hygiene: Generate keyframe after sending offer
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        try {
          // @ts-ignore - generateKeyFrame is experimental
          await sender.generateKeyFrame?.();
          console.log(`[HOST] Generated keyframe for viewer ${viewerUserId.substring(0, 8)}`);
        } catch (err) {
          // Ignore errors - some browsers don't support this
        }
      }
    }
  }

  async function handleGuestOffer(guestUserId: string, sdp: RTCSessionDescriptionInit) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    guestPcRef.current = pc;
    setActiveGuestId(guestUserId);
    
    // Add local tracks to guest connection (use simulcast for video)
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        if (track.kind === 'video') {
          await addVideoTrackWithSimulcast(pc, track, localStreamRef.current);
        } else {
          pc.addTrack(track, localStreamRef.current);
        }
      }
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
      
      // Set playout delay hint for low-latency playback (0.2s)
      if (event.receiver) {
        setPlayoutDelayHint(event.receiver, 0.2);
      }
      
      // Request keyframe after guest joins for faster first frame
      requestKeyFrame(pc);
      
      // Fan out guest tracks to all viewers
      setTimeout(() => renegotiateAllViewers(), 500);
    };
    
    // Monitor connection state for ICE restart
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        // Connection succeeded - clear recovery state
        clearRecoveryState('guest');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // Connection failed - attempt recovery with exponential backoff (2s, 4s, 8s)
        const qualityManager = qualityManagers.current.get('guest');
        attemptRecovery('guest', pc, qualityManager);
      }
    };
    
    // Monitor ICE connection state for transport stability
    pc.oniceconnectionstatechange = () => {
      const qualityManager = qualityManagers.current.get('guest');
      
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        if (qualityManager) {
          qualityManager.pauseDownshifts(5000);
        }
      }
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
    // Enable OPUS FEC/DTX for audio resilience
    if (answer.sdp) {
      answer.sdp = enableOpusFecDtx(answer.sdp);
    }
    await pc.setLocalDescription(answer);
    
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_answer',
      streamId,
      toUserId: guestUserId,
      sdp: answer
    }));
  }

  async function renegotiateAllViewers(retryCount = 0) {
    // Queue management: prevent concurrent renegotiations
    if (renegotiationInProgress.current) {
      console.log('Renegotiation already in progress, queuing this request');
      pendingRenegotiation.current = true;
      return;
    }
    
    renegotiationInProgress.current = true;
    
    try {
      for (const [viewerUserId, pc] of Array.from(viewerPcs.current.entries())) {
        try {
          // Remove all senders and re-add with both host and guest tracks
          const senders = pc.getSenders();
          for (const sender of senders) {
            pc.removeTrack(sender);
          }
          
          // Add host tracks (use simulcast for video)
          if (localStreamRef.current) {
            for (const track of localStreamRef.current.getTracks()) {
              if (track.kind === 'video') {
                await addVideoTrackWithSimulcast(pc, track, localStreamRef.current);
              } else {
                pc.addTrack(track, localStreamRef.current);
              }
            }
          }
          
          // Add guest tracks if available (use simulcast for video)
          if (guestStreamRef.current) {
            for (const track of guestStreamRef.current.getTracks()) {
              if (track.kind === 'video') {
                await addVideoTrackWithSimulcast(pc, track, guestStreamRef.current);
              } else {
                pc.addTrack(track, guestStreamRef.current);
              }
            }
          }
          
          // Reapply quality settings after renegotiation
          const qualityManager = qualityManagers.current.get(viewerUserId);
          if (qualityManager) {
            await reapplyQualitySettings(pc, qualityManager);
          }
          
          const offer = await pc.createOffer();
          // Enable OPUS FEC/DTX for audio resilience
          if (offer.sdp) {
            offer.sdp = enableOpusFecDtx(offer.sdp);
          }
          
          try {
            await pc.setLocalDescription(offer);
          } catch (error: any) {
            // Glare handling: rollback on InvalidStateError
            if (error.name === 'InvalidStateError') {
              console.warn('Glare detected during renegotiation, rolling back');
              await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
              
              // Retry with exponential backoff (max 3 retries)
              if (retryCount < 3) {
                const delay = 100 * Math.pow(2, retryCount);
                console.log(`Retrying renegotiation in ${delay}ms (attempt ${retryCount + 1}/3)`);
                setTimeout(() => {
                  renegotiationInProgress.current = false;
                  renegotiateAllViewers(retryCount + 1);
                }, delay);
                return;
              } else {
                console.error('Max retries reached for renegotiation');
                throw error;
              }
            }
            throw error;
          }
          
          // Request keyframe after renegotiation for faster recovery
          setTimeout(() => requestKeyFrame(pc), 500);
          
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
          console.error(`Renegotiation error for viewer ${viewerUserId}:`, error);
        }
      }
    } finally {
      renegotiationInProgress.current = false;
      
      // Process pending renegotiation if queued
      if (pendingRenegotiation.current) {
        pendingRenegotiation.current = false;
        setTimeout(() => renegotiateAllViewers(), 100);
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
    // Stop local media tracks
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    setLocalStream(null);
    localStreamRef.current = null;
    setIsLive(false);
    setWsConnected(false);
    
    // Clean up viewer connections (stop senders before closing)
    viewerPcs.current.forEach(pc => {
      // Stop all sender tracks to ensure clean teardown
      pc.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      pc.close();
    });
    viewerPcs.current.clear();
    
    // Clean up quality managers
    qualityManagers.current.clear();
    
    // Clean up monitoring
    monitoringCleanups.current.forEach(cleanup => cleanup());
    monitoringCleanups.current.clear();
    
    // Clean up candidate handlers
    candidateHandlerCleanups.current.forEach(cleanup => cleanup());
    candidateHandlerCleanups.current.clear();
    
    // Clean up recovery timeouts
    recoveryTimeouts.current.forEach(timeout => clearTimeout(timeout));
    recoveryTimeouts.current.clear();
    recoveryAttempts.current.clear();
    
    // Clean up guest connection and streams
    if (guestPcRef.current) {
      guestPcRef.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      guestPcRef.current.close();
      guestPcRef.current = null;
    }
    
    // Stop guest stream tracks
    guestStreamRef.current?.getTracks().forEach(track => track.stop());
    guestStreamRef.current = null;
    
    // Clear guest UI state
    setActiveGuestId(null);
    setGuestMuted(false);
    setGuestCamOff(false);
    
    // Clear video element refs
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (guestVideoRef.current) {
      guestVideoRef.current.srcObject = null;
    }
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
    // Stop quality monitoring for guest
    const guestMonitoring = monitoringCleanups.current.get('guest');
    if (guestMonitoring) {
      guestMonitoring();
      monitoringCleanups.current.delete('guest');
    }
    qualityManagers.current.delete('guest');
    
    // Close guest connection (stop senders first)
    if (guestPcRef.current) {
      guestPcRef.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      guestPcRef.current.close();
      guestPcRef.current = null;
    }
    
    // Stop guest stream tracks
    guestStreamRef.current?.getTracks().forEach(track => track.stop());
    guestStreamRef.current = null;
    
    if (guestVideoRef.current) {
      guestVideoRef.current.srcObject = null;
    }
    
    setActiveGuestId(null);
    setGuestMuted(false);
    setGuestCamOff(false);
    
    // Notify server
    wsRef.current?.send(JSON.stringify({
      type: 'cohost_ended',
      streamId,
      by: 'host'
    }));
    
    // Renegotiate all viewers to remove guest tracks
    renegotiateAllViewers();
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
      {/* Build Tag Badge */}
      <div className="fixed top-2 right-2 z-[60]">
        <Badge variant="default" className="bg-purple-600 hover:bg-purple-700" data-testid="badge-build-tag">
          HUD ACTIVE – WAVE3-H264-MVP
        </Badge>
      </div>
      
      {/* Reconnecting Banner */}
      {isReconnecting && (
        <div className="fixed top-0 left-0 right-0 bg-yellow-500 text-yellow-950 px-4 py-2 text-center font-medium z-50" data-testid="banner-reconnecting">
          🔄 Reconnecting to stream...
        </div>
      )}
      
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
