import { useEffect, useRef, useState } from 'react';
import { useRoute } from 'wouter';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Volume2, VolumeX } from 'lucide-react';
import {
  getPlatformConstraints,
  initializeQualitySettings,
  requestKeyFrame,
  enableOpusFecDtx,
  setPlayoutDelayHint,
  restartICE
} from '@/lib/webrtc-quality';
import { DebugHUD } from '@/components/DebugHUD';

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
  const [cohostRequestState, setCohostRequestState] =
    useState<CohostRequestState>('idle');
  const [gameState, setGameState] = useState<GameState>({
    version: 0,
    data: null,
    gameId: null
  });
  const [gameInput, setGameInput] = useState('');
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const hostVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const hostPcRef = useRef<RTCPeerConnection | null>(null);
  const guestPcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  ///////////////////////////////////////////////////////////////////////////////////////////////////////
  const heartbeatIntervalRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const recoveryTimeouts = useRef<Map<string, number>>(new Map());

  ///////////////////////////////////////////////////////////////////////////////////////////////////////
  const reconnectAttemptsRef = useRef(0);
  const roleRef = useRef<Role>('viewer');
  const stopMonitoringRef = useRef<(() => void) | null>(null);

  // Connection recovery state (tracks retry attempts per connection)
  const recoveryAttempts = useRef<Map<string, number>>(new Map());
  // If you store timeouts in a Map:

  // ICE candidate logging flags
  const haveLoggedFirstHostIce = useRef(false);
  const haveLoggedFirstGuestIce = useRef(false);
  async function upgradeToGuest() {
    try {
      // Use platform-optimized constraints (720p @ 30fps, voice-optimized audio)
      const stream = await navigator.mediaDevices.getUserMedia(
        getPlatformConstraints()
      );

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
      const { stopMonitoring } = await initializeQualitySettings(
        pc,
        stream,
        'high',
        true
      );
      stopMonitoringRef.current = stopMonitoring;

      // Receive host tracks
      pc.ontrack = event => {
        const [stream] = event.streams;

        // Log track arrival
        console.log('[VIEWER] ontrack', event.track.kind, stream?.id);

        if (hostVideoRef.current) {
          hostVideoRef.current.srcObject = stream;
          // Explicit play() call with autoplay fallback
          hostVideoRef.current.play().catch(err => {
            console.warn('[VIEWER] Autoplay blocked:', err);
            setAutoplayBlocked(true);
          });

          // 5s keyframe watchdog for video tracks
          if (event.track.kind === 'video') {
            setTimeout(() => {
              if (hostVideoRef.current && hostVideoRef.current.readyState < 2) {
                console.warn(
                  '[VIEWER] Video not ready after 5s, requesting keyframe'
                );
                if (event.receiver && 'requestKeyFrame' in event.receiver) {
                  (event.receiver as any).requestKeyFrame?.();
                }
              }
            }, 5000);
          }
        }

        // Set playout delay hint for low-latency playback (0.2s)
        if (event.receiver) {
          setPlayoutDelayHint(event.receiver, 0.2);
        }

        // Request keyframe for faster first frame
        requestKeyFrame(pc);
      };

      pc.onicecandidate = event => {
        if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'ice_candidate',
              streamId,
              toUserId: 'host',
              fromUserId: userId,
              candidate: event.candidate
            })
          );
        }
      };

      // Monitor connection state for ICE restart
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          // Connection succeeded - clear recovery state
          clearRecoveryState('guest');
        } else if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected'
        ) {
          // Connection failed - attempt recovery with exponential backoff (2s, 4s, 8s)
          attemptRecovery('guest', pc);
        }
      };

      // Monitor ICE connection state for transport stability
      pc.oniceconnectionstatechange = () => {
        if (
          pc.iceConnectionState === 'disconnected' ||
          pc.iceConnectionState === 'failed'
        ) {
          console.log(
            '⚠️  ICE connection degraded, connection may recover automatically'
          );
        }
      };

      const offer = await pc.createOffer();
      // Enable OPUS FEC/DTX for audio resilience
      if (offer.sdp) {
        offer.sdp = enableOpusFecDtx(offer.sdp);
      }
      await pc.setLocalDescription(offer);
      console.log('[VIEWER] Sending cohost_offer to host');

      wsRef.current?.send(
        JSON.stringify({
          type: 'cohost_offer',
          streamId,
          toUserId: 'host',
          fromUserId: userId,
          sdp: offer
        })
      );
    } catch (error) {
      toast({
        title: 'Camera Error',
        description: 'Could not access camera/microphone',
        variant: 'destructive'
      });

      setRole('viewer');
      setCohostRequestState('idle');
    }
  }
  // Keep roleRef in sync
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  // Set build tag for cache-busting verification
  useEffect(() => {
    (window as any).__BUILD_TAG__ = 'WAVE3-H264-MVP';
    console.info('[BUILD]', (window as any).__BUILD_TAG__);
  }, []);

  // WebSocket setup
  useEffect(() => {
    if (!isJoined) return;

    function connect() {
      const ws = new WebSocket(wsUrl('/ws'));
      wsRef.current = ws;

      /*************  ✨ Windsurf Command ⭐  *************/
      /**
       * WebSocket onopen event handler.
       * Called when the WebSocket connection is established.
       * Reconnects the WebSocket connection when the connection is closed.
       * Resets reconnect attempts counter.
      /*******  77c63eae-9855-4fb6-a251-e6ba2b01a220  *******/
      ws.onopen = () => {
        setWsConnected(true);
        setIsReconnecting(false); // optional: drop banner immediately
        reconnectAttemptsRef.current = 0;

        // if a reconnect timeout was pending, kill it
        if (reconnectTimeoutRef.current != null) {
          window.clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        // Detect iOS/Safari for codec preference
        const isIOSSafari =
          /iPhone|iPad|iPod/.test(navigator.userAgent) &&
          /Safari/.test(navigator.userAgent);

        // Join as viewer or guest
        ws.send(
          JSON.stringify({
            type: 'join_stream',
            streamId,
            role: roleRef.current,
            userId,
            isIOSSafari
          })
        );

        // Start heartbeat
        if (heartbeatIntervalRef.current != null) {
          window.clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        heartbeatIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
          }
        }, 25000);

        // Sync game state
        if (gameState.gameId) {
          ws.send(
            JSON.stringify({
              type: 'game_sync',
              streamId
            })
          );
        }
      };

      ws.onerror = e => {
        console.warn('[WS] error', e);
        // optional UX
        toast({
          title: 'Connection error',
          description: 'Trying to recover…'
        });
      };

      ws.onclose = () => {
        setWsConnected(false);

        // stop heartbeat
        if (heartbeatIntervalRef.current != null) {
          window.clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }

        // Auto-reconnect
        if (isJoined) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            30000
          );
          reconnectAttemptsRef.current++;

          toast({
            title: 'Reconnecting...',
            description: `Attempting to reconnect in ${Math.floor(
              delay / 1000
            )}s`
          });

          // 🔻 clear any pending reconnect timer before scheduling a new one
          if (reconnectTimeoutRef.current !== null) {
            window.clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }

          reconnectTimeoutRef.current = window.setTimeout(connect, delay);
        }
      };

      ws.onmessage = async event => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'webrtc_offer' && msg.toUserId === userId) {
          await handleHostOffer(msg.sdp, msg.metadata);
        } else if (
          msg.type === 'ice_candidate' &&
          msg.toUserId === userId && // <-- we only accept ICE addressed to us
          msg.candidate
        ) {
          const pc =
            roleRef.current === 'guest'
              ? guestPcRef.current
              : hostPcRef.current;
          if (!pc) return;
          // Log first ICE candidate once per connection

          // Optional logging
          if (msg.fromUserId === 'host' && !haveLoggedFirstHostIce.current) {
            console.log('[VIEWER] First ICE candidate received from host');
            haveLoggedFirstHostIce.current = true;
          } else if (
            msg.fromUserId &&
            msg.fromUserId !== 'host' &&
            !haveLoggedFirstGuestIce.current
          ) {
            console.log(
              '[VIEWER] First ICE candidate received from',
              msg.fromUserId
            );
            haveLoggedFirstGuestIce.current = true;
          }
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (err) {
            console.warn('[VIEWER] addIceCandidate failed:', err);
          }
        } else if (msg.type === 'cohost_accepted') {
          setCohostRequestState('accepted');
          setRole('guest');

          toast({
            title: 'Approved!',
            description: 'You are now a co-host. Starting camera...'
          });

          // Upgrade to guest with local media
          await upgradeToGuest();
        } else if (msg.type === 'cohost_declined') {
          setCohostRequestState('declined');

          toast({
            title: 'Request Declined',
            description: msg.reason || 'The host declined your request',
            variant: 'destructive'
          });

          setTimeout(() => setCohostRequestState('idle'), 3000);
        } else if (msg.type === 'cohost_ended') {
          setRole('viewer');
          setCohostRequestState('idle');

          // Stop quality monitoring if active
          if (stopMonitoringRef.current) {
            stopMonitoringRef.current();
            stopMonitoringRef.current = null;
          }

          // Stop local tracks
          localStreamRef.current?.getTracks().forEach(track => track.stop());
          localStreamRef.current = null;

          // Close guest peer connection (stop senders first)
          if (guestPcRef.current) {
            guestPcRef.current.getSenders().forEach(sender => {
              if (sender.track) {
                sender.track.stop();
              }
            });
            guestPcRef.current.close();
            guestPcRef.current = null;
          }

          if (localVideoRef.current) {
            localVideoRef.current.srcObject = null; // ✅ starting co-host
          }

          // ✅ Add this to feed PiP with your local camera (video-only to avoid echo) - this is only if you want the Viewer to see themselves in a small window in the Host session, which in our case we don't. The Viewer is only meant to watch the host.
          // if (guestVideoRef.current) {
          //   const videoOnly = new MediaStream(stream.getVideoTracks());
          //   guestVideoRef.current.srcObject = videoOnly;
          //   guestVideoRef.current.muted = true;
          //   guestVideoRef.current.play?.().catch(() => {});
          // }

          toast({
            title: 'Co-host Ended',
            description: 'You are back to viewer mode'
          });
        } else if (msg.type === 'cohost_mute' || msg.type === 'cohost_unmute') {
          const shouldMute = msg.type === 'cohost_mute';
          localStreamRef.current?.getAudioTracks().forEach(track => {
            track.enabled = !shouldMute;
          });

          toast({
            title: shouldMute ? 'Muted by Host' : 'Unmuted by Host'
          });
        } else if (
          msg.type === 'cohost_cam_off' ||
          msg.type === 'cohost_cam_on'
        ) {
          const shouldDisable = msg.type === 'cohost_cam_off';
          localStreamRef.current?.getVideoTracks().forEach(track => {
            track.enabled = !shouldDisable;
          });

          toast({
            title: shouldDisable ? 'Camera Off by Host' : 'Camera On by Host'
          });
        } else if (msg.type === 'game_init' && msg.initialState) {
          setGameState({
            version: 1,
            data: msg.initialState,
            gameId: msg.gameId
          });

          toast({
            title: 'Game Started!',
            description: `Playing ${msg.gameId}`
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
      // Close WebSocket
      if (wsRef.current) {
        wsRef.current.close();
      }

      // Clear timers
      if (heartbeatIntervalRef.current != null) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (reconnectTimeoutRef.current != null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Stop quality monitoring if active
      if (stopMonitoringRef.current != null) {
        stopMonitoringRef.current();
        stopMonitoringRef.current = null;
      }

      // Clean up host peer connection
      if (hostPcRef.current != null) {
        hostPcRef.current.close();
        hostPcRef.current = null;
      }

      // Clean up guest peer connection and local media
      if (guestPcRef.current) {
        guestPcRef.current.getSenders().forEach(sender => {
          if (sender.track) {
            sender.track.stop();
          }
        });
        guestPcRef.current.close();
        guestPcRef.current = null;
      }

      // Stop local media tracks
      localStreamRef.current?.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;

      // Clear video element refs
      if (hostVideoRef.current) {
        hostVideoRef.current.srcObject = null;
      }
      if (guestVideoRef.current) {
        guestVideoRef.current.srcObject = null;
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
      // Clean up recovery timeouts
      recoveryTimeouts.current.forEach(timeout => window.clearTimeout(timeout));
      recoveryTimeouts.current.clear();
      recoveryAttempts.current.clear();
    };
  }, [isJoined, streamId]);

  // Network change handling - trigger recovery on network events
  useEffect(() => {
    if (!isJoined) return;

    const handleOnline = () => {
      console.log('🌐 Network came online');
      toast({
        title: 'Network Restored',
        description: 'Reconnecting to stream...'
      });

      // Trigger recovery for active connections
      if (
        hostPcRef.current &&
        hostPcRef.current.connectionState !== 'connected'
      ) {
        attemptRecovery('host', hostPcRef.current);
      }

      if (
        guestPcRef.current &&
        guestPcRef.current.connectionState !== 'connected'
      ) {
        attemptRecovery('guest', guestPcRef.current);
      }
    };

    const handleOffline = () => {
      console.log('🌐 Network went offline');
      setIsReconnecting(true);
    };

    const handleNetworkChange = () => {
      console.log('🌐 Network type changed');
      // Trigger ICE restart for all connections when network type changes
      if (hostPcRef.current) {
        attemptRecovery('host', hostPcRef.current);
      }

      if (guestPcRef.current) {
        attemptRecovery('guest', guestPcRef.current);
      }
    };

    // Listen for online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Listen for network type changes (if available)
    const connection =
      (navigator as any).connection ||
      (navigator as any).mozConnection ||
      (navigator as any).webkitConnection;
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
  }, [isJoined]);

  /**
   * Attempt connection recovery with exponential backoff (2s, 4s, 8s)
   * Max 3 attempts before giving up
   */
  function attemptRecovery(connectionId: string, pc: RTCPeerConnection) {
    const attempts = recoveryAttempts.current.get(connectionId) || 0;

    // Set reconnecting UI state
    setIsReconnecting(true);

    // Clear any pending recovery timeout
    const existingTimeout = recoveryTimeouts.current.get(connectionId);
    if (existingTimeout != null) {
      window.clearTimeout(existingTimeout);
      recoveryTimeouts.current.delete(connectionId);
    }

    // Max 3 attempts
    if (attempts >= 3) {
      console.log(
        `❌ Connection recovery failed after 3 attempts: ${connectionId}`
      );
      recoveryAttempts.current.delete(connectionId);
      recoveryTimeouts.current.delete(connectionId);

      // Only clear reconnecting state if no other connections are recovering
      if (recoveryAttempts.current.size === 0) {
        setIsReconnecting(false);
      }

      toast({
        title: 'Connection Lost',
        description: 'Failed to reconnect to the stream',
        variant: 'destructive'
      });
      return;
    }

    // Exponential backoff: 2s, 4s, 8s
    const delays = [2000, 4000, 8000];
    const delay = delays[attempts];

    console.log(
      `🔄 Scheduling recovery attempt ${
        attempts + 1
      }/3 for ${connectionId} in ${delay}ms`
    );

    const timeout = window.setTimeout(async () => {
      console.log(
        `🔄 Attempting recovery ${attempts + 1}/3 for ${connectionId}`
      );

      // Increment attempt counter
      recoveryAttempts.current.set(connectionId, attempts + 1);

      // Trigger ICE restart
      await restartICE(pc);

      toast({
        title: 'Reconnecting...',
        description: `Attempt ${attempts + 1} of 3`
      });
    }, delay);

    recoveryTimeouts.current.set(connectionId, timeout);
  }

  /**
   * Clear recovery state when connection succeeds
   */
  function clearRecoveryState(connectionId: string) {
    const existingTimeout = recoveryTimeouts.current.get(connectionId);
    if (existingTimeout != null) {
      window.clearTimeout(existingTimeout);
    }
    recoveryAttempts.current.delete(connectionId);
    recoveryTimeouts.current.delete(connectionId);

    // Clear reconnecting UI state if no other connections are recovering
    if (recoveryAttempts.current.size === 0) {
      setIsReconnecting(false);
    }
  }

  /*************  ✨ Windsurf Command ⭐  *************/
  /**
   * Handle a WebRTC offer from the host and set up a new PeerConnection
   * with the host. This function is responsible for creating a new
   * PeerConnection, attaching the host's stream to the viewer's video
   * element, sending the host's ICE candidates, and creating and sending
   * an answer to the host.
   *
   * @param {RTCSessionDescriptionInit} sdp - The host's WebRTC offer
   * @param {Object} [metadata] - Optional metadata object with hostStreamId
   * and guestStreamId properties
   */
  /*******  b82d3833-8c7c-48c0-a715-0cf144c42f6c  *******/
  async function handleHostOffer(
    sdp: RTCSessionDescriptionInit,
    metadata?: { hostStreamId?: string; guestStreamId?: string }
  ) {
    // 1) New PC
    if (hostPcRef.current) hostPcRef.current.close();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    hostPcRef.current = pc;

    // 2) ontrack: attach stream
    pc.ontrack = e => {
      const [stream] = e.streams;
      if (!stream || !hostVideoRef.current) return;

      const video = hostVideoRef.current;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.play().catch(() => setAutoplayBlocked(true));

      requestKeyFrame(pc);
    };

    // 3) ICE out
    pc.onicecandidate = event => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'ice_candidate',
            streamId,
            toUserId: 'host',
            fromUserId: userId,
            candidate: event.candidate
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearRecoveryState('host');
      } else if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        attemptRecovery('host', pc);
      }
    };

    // 4) IMPORTANT: do NOT add transceivers here; just apply the host's offer
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    // 5) Create/send answer (you can keep OPUS FEC/DTX tweak if you want)
    const answer = await pc.createAnswer();
    if (answer.sdp) {
      answer.sdp = enableOpusFecDtx(answer.sdp);
    }
    await pc.setLocalDescription(answer);

    wsRef.current?.send(
      JSON.stringify({
        type: 'webrtc_answer',
        streamId,
        toUserId: 'host',
        fromUserId: userId,
        sdp: answer
      })
    );
  }

  function joinStream() {
    setIsJoined(true);
  }

  function requestCohost() {
    console.log('[VIEWER] cohost_request sent');
    setCohostRequestState('pending');
    wsRef.current?.send(
      JSON.stringify({
        type: 'cohost_request',
        streamId,
        userId
      })
    );

    toast({
      title: 'Request Sent',
      description: 'Waiting for host approval...'
    });
  }

  function cancelCohostRequest() {
    setCohostRequestState('idle');
    wsRef.current?.send(
      JSON.stringify({
        type: 'cohost_cancel',
        streamId,
        userId
      })
    );
  }

  function submitGameInput() {
    if (!gameInput.trim() || !gameState.gameId) return;

    wsRef.current?.send(
      JSON.stringify({
        type: 'game_event',
        streamId,
        eventType: 'player_submission',
        payload: {
          submission: gameInput,
          round: gameState.data?.round || 1
        },
        from: userId
      })
    );

    setGameInput('');

    toast({
      title: 'Submitted!',
      description: 'Your answer has been sent'
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
    <div className='min-h-screen bg-background p-4'>
      {/* Build Tag Badge */}
      <div className='fixed top-2 right-2 z-[60]'>
        <Badge
          variant='default'
          className='bg-purple-600 hover:bg-purple-700'
          data-testid='badge-build-tag'
        >
          HUD ACTIVE – WAVE3-H264-MVP
        </Badge>
      </div>

      {/* Reconnecting Banner */}
      {isReconnecting && (
        <div
          className='fixed top-0 left-0 right-0 bg-yellow-500 text-yellow-950 px-4 py-2 text-center font-medium z-50'
          data-testid='banner-reconnecting'
        >
          🔄 Reconnecting to stream...
        </div>
      )}

      <div className='max-w-4xl mx-auto space-y-4'>
        <div className='flex items-center justify-between'>
          <h1 className='text-2xl font-bold'>Watch Stream</h1>
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
                className='w-full'
                data-testid='button-join-stream'
              >
                Join Stream
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Stream Player */}
            <Card>
              <CardContent className='p-0'>
                <div className='relative aspect-video bg-black rounded-lg overflow-hidden'>
                  <video
                    ref={hostVideoRef}
                    autoPlay
                    playsInline
                    muted={isMuted}
                    className='w-full h-full object-cover'
                    data-testid='video-host-stream'
                  />

                  {/* Guest video (picture-in-picture if present) */}
                  {guestVideoRef.current?.srcObject && (
                    <div className='absolute bottom-4 right-4 w-32 h-32 rounded-lg overflow-hidden border-2 border-white'>
                      <video
                        ref={guestVideoRef}
                        autoPlay
                        playsInline
                        className='w-full h-full object-cover'
                        data-testid='video-guest-stream'
                      />
                    </div>
                  )}

                  {/* Autoplay blocked overlay */}
                  {autoplayBlocked && (
                    <div
                      className='absolute inset-0 bg-black/80 flex items-center justify-center cursor-pointer'
                      onClick={unmute}
                      data-testid='overlay-tap-to-play'
                    >
                      <div className='text-center space-y-2'>
                        <Volume2 className='w-12 h-12 mx-auto text-white' />
                        <div className='text-white font-semibold'>
                          Tap to Play
                        </div>
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
                      className='absolute bottom-4 left-4 p-2 bg-black/50 rounded-full text-white'
                      data-testid='button-toggle-mute'
                    >
                      {isMuted ? (
                        <VolumeX className='w-5 h-5' />
                      ) : (
                        <Volume2 className='w-5 h-5' />
                      )}
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Co-host Controls */}
            {role === 'viewer' && (
              <Card>
                <CardContent className='p-4'>
                  {cohostRequestState === 'idle' && (
                    <Button
                      onClick={requestCohost}
                      className='w-full'
                      data-testid='button-request-cohost'
                    >
                      Request Co-host
                    </Button>
                  )}
                  {cohostRequestState === 'pending' && (
                    <div className='space-y-2'>
                      <div className='text-sm text-center text-muted-foreground'>
                        Waiting for host approval...
                      </div>
                      <Button
                        onClick={cancelCohostRequest}
                        variant='outline'
                        className='w-full'
                        data-testid='button-cancel-cohost'
                      >
                        Cancel Request
                      </Button>
                    </div>
                  )}
                  {cohostRequestState === 'declined' && (
                    <div className='text-sm text-center text-destructive'>
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
                  <CardTitle className='text-base'>Your Camera</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className='aspect-video bg-muted rounded-lg overflow-hidden'>
                    <video
                      ref={localVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className='w-full h-full object-cover'
                      data-testid='video-local-preview'
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Game Input */}
            {gameState.gameId && gameState.data?.phase === 'submit' && (
              <Card>
                <CardHeader>
                  <CardTitle className='text-base'>
                    {gameState.gameId}
                  </CardTitle>
                  <CardDescription>
                    Round {gameState.data?.round || 1}
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-2'>
                  <Input
                    value={gameInput}
                    onChange={e => setGameInput(e.target.value)}
                    placeholder='Enter your caption...'
                    onKeyDown={e => e.key === 'Enter' && submitGameInput()}
                    data-testid='input-game-submission'
                  />
                  <Button
                    onClick={submitGameInput}
                    disabled={!gameInput.trim()}
                    className='w-full'
                    data-testid='button-submit-game'
                  >
                    Submit
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Debug HUD (always visible) */}
        {isJoined && (
          <DebugHUD
            pc={hostPcRef.current}
            onRequestKeyframe={() => {
              // Send WS message to host to trigger keyframe generation
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(
                  JSON.stringify({
                    type: 'request_keyframe',
                    streamId,
                    toUserId: 'host'
                  })
                );
                toast({
                  title: 'Keyframe Requested',
                  description: 'Sent request to host'
                });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
