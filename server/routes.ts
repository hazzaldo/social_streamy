import type { Express } from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  MessageDeduplicator,
  TokenBucketRateLimiter,
  SessionManager,
  MetricsTracker,
  MessageCoalescer,
  BackpressureMonitor,
  PayloadValidator
} from './signaling-utils';
import { GracefulShutdown } from './graceful-shutdown';
import { validateWebSocketOrigin } from './security';
import { MessageRouter } from './message-router';
import {
  handleJoinStream,
  handleResume,
  handleWebRTCOffer,
  handleWebRTCAnswer,
  handleICECandidate,
  handleRequestOffer
} from './wave1-handlers';

// In-memory room and participant tracking
interface Participant {
  ws: WebSocket;
  userId: string;
  streamId: string;
  role: 'host' | 'viewer' | 'guest';
}

interface CohostRequest {
  userId: string;
  timestamp: number;
}

interface GameState {
  version: number;
  data: any;
  gameId: string | null;
  seed?: number;
}

interface RateLimitTracker {
  tokens: number;
  lastRefill: number;
}

interface RoomState {
  participants: Map<string, Participant>;
  activeGuestId: string | null;
  cohostQueue: CohostRequest[];
  gameState: GameState;
  rateLimits: Map<string, RateLimitTracker>;
}

const rooms = new Map<string, RoomState>();

// Store latest validation report for /healthz
let latestValidationReport: any = null;

// Initialize signaling utilities
const deduplicator = new MessageDeduplicator();
const sessionManager = new SessionManager();
const metrics = new MetricsTracker();
const coalescer = new MessageCoalescer();
const backpressureMonitor = new BackpressureMonitor();
const payloadValidator = new PayloadValidator();

// Phase 2: Initialize message router with feature flag
const ROUTER_ENABLED = process.env.ROUTER_ENABLED !== 'false'; // Default: true
const DEBUG_SDP = process.env.DEBUG_SDP === 'true'; // Default: false
const router = new MessageRouter(metrics, DEBUG_SDP);

// Wave 1: Register critical signaling handlers
router.register('join_stream', handleJoinStream);
router.register('resume', handleResume);
router.register('webrtc_offer', handleWebRTCOffer);
router.register('webrtc_answer', handleWebRTCAnswer);
router.register('ice_candidate', handleICECandidate);

// Rate limiters
const iceCandidateRateLimiter = new TokenBucketRateLimiter(50, 50, 100); // 50/sec, burst 100
const gameEventRateLimiter = new TokenBucketRateLimiter(5, 5, 10); // 5/sec, burst 10

// Track socket IDs for deduplication
const socketIds = new WeakMap<WebSocket, string>();
let nextSocketId = 1;

export async function registerRoutes(app: Express): Promise<Server> {
  // Health endpoints
  app.get('/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/healthz', (_req, res) => {
    // Minimal health endpoint with room summary (H.264-only debug mode)
    res.json({
      rooms: Array.from(rooms.entries()).map(([id, roomState]) => ({
        id,
        viewersCount: Array.from(roomState.participants.values()).filter(
          p => p.role === 'viewer'
        ).length,
        h264Only: true
      }))
    });
  });

  app.get('/_version', (_req, res) => {
    res.json({
      build: 'WAVE3-H264-MVP',
      timestamp: new Date().toISOString(),
      commitHash: process.env.REPL_SLUG || 'local'
    });
  });

  // Readiness endpoint for production deployment
  app.get('/readyz', (_req, res) => {
    const checks: { [key: string]: boolean } = {};
    const issues: string[] = [];

    // Check 1: Router enabled
    checks.routerEnabled = ROUTER_ENABLED;
    if (!ROUTER_ENABLED) {
      issues.push('Router is disabled');
    }

    // Check 2: TURN credentials configured
    const hasTurnUrl = !!process.env.TURN_URL || !!process.env.TURNS_URL;
    const hasTurnCreds =
      !!process.env.TURN_USERNAME && !!process.env.TURN_CREDENTIAL;
    checks.turnConfigured = hasTurnUrl && hasTurnCreds;
    if (!checks.turnConfigured) {
      if (!hasTurnUrl) issues.push('TURN_URL or TURNS_URL not configured');
      if (!hasTurnCreds) issues.push('TURN credentials not configured');
    }

    // Check 3: Error rate check (last 1 minute)
    // Get invalid_request and payload_too_large error counts
    const errorMetrics = metrics.getPrometheusFormat();
    const invalidRequestMatch = errorMetrics.match(
      /errors_total\{code="invalid_request"\}\s+(\d+)/
    );
    const payloadTooLargeMatch = errorMetrics.match(
      /errors_total\{code="payload_too_large"\}\s+(\d+)/
    );

    const invalidRequestCount = invalidRequestMatch
      ? parseInt(invalidRequestMatch[1])
      : 0;
    const payloadTooLargeCount = payloadTooLargeMatch
      ? parseInt(payloadTooLargeMatch[1])
      : 0;

    // Simple check: total errors should be below threshold
    const errorThreshold = 5; // errors per minute threshold
    const totalErrors = invalidRequestCount + payloadTooLargeCount;
    checks.errorRateOk = totalErrors < errorThreshold;
    if (!checks.errorRateOk) {
      issues.push(
        `Error rate too high: ${totalErrors} errors (threshold: ${errorThreshold})`
      );
    }

    // Check 4: WebSocket server is operational (has at least processed some connections)
    // We consider it operational if router is handling messages or we have active rooms
    checks.wsOperational = true; // WebSocket server is up if we're responding to this request

    const allChecksPass = Object.values(checks).every(v => v);

    if (allChecksPass) {
      res.status(200).json({
        ready: true,
        timestamp: new Date().toISOString(),
        checks
      });
    } else {
      res.status(503).json({
        ready: false,
        timestamp: new Date().toISOString(),
        checks,
        issues
      });
    }
  });

  // Prometheus metrics endpoint
  app.get('/metrics', (_req, res) => {
    // Update gauges before generating metrics
    metrics.setGauge(
      'connected_sockets',
      Array.from(rooms.values()).reduce(
        (sum, r) => sum + r.participants.size,
        0
      )
    );
    metrics.setGauge('rooms_total', rooms.size);

    const avgRoomSize =
      rooms.size > 0
        ? Array.from(rooms.values()).reduce(
            (sum, r) => sum + r.participants.size,
            0
          ) / rooms.size
        : 0;
    metrics.setGauge('avg_room_size', avgRoomSize);

    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics.getPrometheusFormat());
  });

  // Validation endpoint for CI/CD
  app.post('/validate', (_req, res) => {
    // Return the latest validation report or trigger a new one
    if (latestValidationReport) {
      res.json({
        ok: true,
        report: latestValidationReport
      });
    } else {
      res.json({
        ok: false,
        message:
          'No validation report available. Run validation from the Test Harness UI.'
      });
    }
  });

  // Endpoint to submit validation report from client
  app.post('/validate/report', (req, res) => {
    const report = req.body;
    latestValidationReport = {
      ...report,
      receivedAt: new Date().toISOString()
    };
    console.log('📊 Validation report received:', {
      timestamp: report.timestamp,
      overallStatus: report.overallStatus,
      duration: report.duration
    });
    res.json({ ok: true });
  });

  const httpServer = createServer(app);

  // Create WS server in noServer mode (we'll gate at HTTP upgrade)
  const wss = new WebSocketServer({ noServer: true });

  // Intercept HTTP upgrade and validate origin + path before upgrading
  httpServer.on('upgrade', (req, socket, head) => {
    // Only handle our WS endpoint
    const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin as string | undefined;
    const isValid = validateWebSocketOrigin(origin);
    if (!isValid) {
      console.warn('🚫 WebSocket upgrade rejected - invalid origin:', origin);
      metrics.increment('ws_rejected_origin');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Hand off to ws only if valid
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    let currentParticipant: Participant | null = null;
    let sessionToken: string | null = null;

    // Assign socket ID for deduplication
    const socketId = `sock_${nextSocketId++}`;
    socketIds.set(ws, socketId);

    console.log('🔌 New WebSocket connection:', socketId);
    metrics.increment('ws_connections_total');

    ws.on('message', async raw => {
      const msgStart = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.error('❌ Failed to parse WebSocket message', e);
        metrics.increment('msgs_parse_errors');
        return;
      }

      // Validate payload
      const validation = payloadValidator.validate(msg);
      if (!validation.valid) {
        console.error('❌ Invalid payload:', validation.error, msg.type);
        ws.send(
          JSON.stringify({
            type: 'error',
            code: validation.error,
            message: 'Invalid message payload'
          })
        );
        metrics.increment('msgs_invalid');
        return;
      }

      // Sanitize message
      msg = payloadValidator.sanitize(msg);

      // Track incoming messages
      metrics.increment(`msgs_in_total`);
      metrics.increment(`msgs_in_${msg.type || 'unknown'}`);

      // Deduplication check
      if (msg.msgId) {
        if (deduplicator.isDuplicate(socketId, msg.msgId)) {
          console.log('🔄 Duplicate message ignored:', msg.msgId, msg.type);
          metrics.increment('msgs_duplicates');
          return;
        }
      }

      console.log('📩 WS Message:', msg.type, msg);

      // Helper functions for both router and legacy paths
      // Helper function to send message with backpressure check and ack
      const sendMessage = (
        targetWs: WebSocket,
        message: any,
        critical: boolean = true
      ) => {
        if (targetWs.readyState !== WebSocket.OPEN) return false;

        // Check backpressure
        if (backpressureMonitor.shouldDrop(targetWs, message.type)) {
          console.warn(
            '⚠️ Dropping non-critical message due to backpressure:',
            message.type
          );
          metrics.increment(`msgs_dropped_${message.type}`);
          return false;
        }

        targetWs.send(JSON.stringify(message));
        metrics.increment('msgs_out_total');
        metrics.increment(`msgs_out_${message.type}`);
        return true;
      };

      // Send acknowledgment for critical messages
      const sendAck = (msgId: string) => {
        if (msgId) {
          sendMessage(
            ws,
            {
              type: 'ack',
              for: msgId,
              ts: Date.now()
            },
            true
          );
        }
      };

      // Send normalized error response
      const sendError = (code: string, message: string) => {
        sendMessage(
          ws,
          {
            type: 'error',
            code,
            message
          },
          true
        );
      };

      // Helper functions for routing (used by both router and legacy)

      // Phase 2: Try router first if enabled (shim pattern - reuse already-parsed message)
      let handled = false;
      if (ROUTER_ENABLED) {
        try {
          // Build context for Wave 1 handlers (pass mutable ref wrappers for state)
          const participantRef = { current: currentParticipant };
          const sessionTokenRef = { current: sessionToken };
          const routerContext = {
            rooms,
            sessionManager,
            currentParticipant: participantRef,
            sessionToken: sessionTokenRef,
            iceCandidateRateLimiter,
            coalescer,
            relayToUser,
            broadcastToRoom,
            sendAck: (msgId: string, type: string) =>
              router.sendAck(ws, msgId, type),
            sendError: (code: string, message: string, ref?: string) =>
              router.sendError(ws, code, message, ref)
          };

          handled = await router.route(ws, msg, socketId, routerContext);

          // Update closure variables if handlers modified them
          if (participantRef.current !== currentParticipant) {
            currentParticipant = participantRef.current;
          }
          if (sessionTokenRef.current !== sessionToken) {
            sessionToken = sessionTokenRef.current;
          }

          if (handled) {
            metrics.increment('msgs_handled_total', {
              handled_by: 'router',
              type: msg.type
            });
            return; // Router handled it, skip legacy
          }
        } catch (error) {
          console.error('[Shim] Router error, falling back to legacy:', error);
          metrics.increment('router_errors');
        }
      }

      // If router didn't handle or disabled, use legacy switch
      if (!handled) {
        metrics.increment('msgs_handled_total', {
          handled_by: 'legacy',
          type: msg.type
        });
      }

      switch (msg.type) {
        case 'ping': {
          // Heartbeat ping - respond with pong for mobile network reliability
          sendMessage(ws, {
            type: 'pong',
            ts: Date.now()
          });
          break;
        }

        case 'request_offer': {
          // Build the context object expected by MessageHandler/MessageContext
          // Reuse variables already defined in this file’s scope.
          await handleRequestOffer(ws, msg, {
            rooms,
            currentParticipant,
            relayToUser,
            sendAck,
            sendError,
            metrics,
            // add the remaining MessageContext fields your project type expects:
            socketId, // if you already have this in scope, pass it
            debugSdp: DEBUG_SDP // if you have a flag in scope, pass it (else: false)
            // If your MessageContext includes more fields, include them here.
          } as any); // <- if TS still complains, keep this cast to satisfy the type
          break;
        }

        case 'resume': {
          // Session resume
          const { sessionToken: token } = msg;
          if (!token) {
            sendMessage(ws, {
              type: 'error',
              code: 'INVALID_RESUME',
              message: 'Missing session token'
            });
            break;
          }

          const session = sessionManager.getSession(token);
          if (!session) {
            sendMessage(ws, {
              type: 'error',
              code: 'SESSION_EXPIRED',
              message: 'Session token expired or invalid'
            });
            break;
          }

          // Restore session
          sessionToken = token;
          const { userId, streamId, role, queuePosition } = session;

          // Get or create room
          if (!rooms.has(streamId)) {
            sendMessage(ws, {
              type: 'resume_migrated',
              role: 'viewer',
              reason: 'room_closed'
            });
            break;
          }

          const roomState = rooms.get(streamId)!;

          // Restore participant
          currentParticipant = { ws, userId, streamId, role: role as any };
          roomState.participants.set(userId, currentParticipant);

          console.log('🔄 Session resumed:', { userId, streamId, role });

          // Send resume confirmation with current game state
          sendMessage(ws, {
            type: 'resume_ok',
            role,
            position: queuePosition,
            gameStateVersion: roomState.gameState.version
          });

          // Send current game state if active
          if (roomState.gameState.gameId) {
            sendMessage(ws, {
              type: 'game_state',
              streamId,
              version: roomState.gameState.version,
              full: true,
              patch: roomState.gameState.data,
              gameId: roomState.gameState.gameId,
              seed: roomState.gameState.seed
            });
          }

          sendAck(msg.msgId);
          break;
        }

        case 'echo': {
          // Echo test for debugging
          ws.send(
            JSON.stringify({
              type: 'connection_echo_test',
              original: msg,
              timestamp: Date.now()
            })
          );
          break;
        }

        case 'join_stream': {
          const { streamId, userId } = msg;

          // Validation: Required fields
          if (!streamId || !userId) {
            console.error('❌ join_stream missing streamId or userId');
            sendError('invalid_request', 'streamId and userId are required');
            return;
          }

          // Validation: Format checks
          if (typeof streamId !== 'string' || typeof userId !== 'string') {
            sendError('invalid_request', 'streamId and userId must be strings');
            return;
          }

          // Validation: Length limits
          if (streamId.length > 100 || userId.length > 100) {
            sendError(
              'invalid_request',
              'streamId and userId must be <= 100 characters'
            );
            return;
          }

          // Get or create room
          if (!rooms.has(streamId)) {
            rooms.set(streamId, {
              participants: new Map(),
              activeGuestId: null,
              cohostQueue: [],
              gameState: { version: 0, data: null, gameId: null },
              rateLimits: new Map()
            });
            console.log('🆕 Room created:', {
              streamId,
              totalRooms: rooms.size
            });
          }
          const roomState = rooms.get(streamId)!;
          const room = roomState.participants;

          // Safety: Room capacity limit (max 100 participants)
          if (room.size >= 100 && !room.has(String(userId))) {
            console.warn('⚠️ Room at capacity:', { streamId, size: room.size });
            sendError(
              'room_full',
              'This room has reached maximum capacity (100 participants)'
            );
            return;
          }

          // Determine role: first participant is host, others are viewers
          const role = room.size === 0 ? 'host' : 'viewer';

          // Add participant to room
          currentParticipant = { ws, userId: String(userId), streamId, role };
          room.set(String(userId), currentParticipant);

          // Create session token for reconnection
          sessionToken = sessionManager.createSession(
            String(userId),
            streamId,
            role
          );

          console.log(`✅ ${role.toUpperCase()} joined stream:`, {
            streamId,
            userId,
            roomSize: room.size,
            totalRooms: rooms.size,
            sessionToken
          });

          // Send join confirmation with session token
          sendMessage(ws, {
            type: 'join_confirmed',
            streamId,
            userId: String(userId),
            role,
            sessionToken
          });

          // If viewer joined, notify the host
          if (role === 'viewer') {
            const host = Array.from(room.values()).find(p => p.role === 'host');
            if (host && host.ws.readyState === WebSocket.OPEN) {
              sendMessage(host.ws, {
                type: 'joined_stream',
                streamId,
                userId: String(userId)
              });
            }
          }

          // Send participant count update to all in room
          broadcastToRoom(streamId, {
            type: 'participant_count_update',
            streamId,
            count: room.size
          });

          // Phase 5: Send current game state if game is active
          if (roomState.gameState.gameId) {
            sendMessage(ws, {
              type: 'game_state',
              streamId,
              version: roomState.gameState.version,
              full: true,
              patch: roomState.gameState.data,
              gameId: roomState.gameState.gameId,
              seed: roomState.gameState.seed
            });
            console.log('🎮 Sent game state to new participant:', {
              userId,
              gameId: roomState.gameState.gameId,
              version: roomState.gameState.version
            });
          }

          sendAck(msg.msgId);
          break;
        }

        case 'leave_stream': {
          const { streamId, userId } = msg;
          if (!streamId || !userId) return;

          const roomState = rooms.get(streamId);
          const participant = roomState?.participants.get(String(userId));
          const role = participant?.role || 'unknown';
          console.log('👋 leave_stream:', {
            streamId,
            userId,
            role,
            roomSize: roomState?.participants.size || 0,
            totalRooms: rooms.size
          });

          if (roomState) {
            const room = roomState.participants;
            const participant = room.get(String(userId));
            const role = participant?.role;

            // Remove from cohost queue if present
            const queueIndex = roomState.cohostQueue.findIndex(
              r => r.userId === String(userId)
            );
            if (queueIndex !== -1) {
              roomState.cohostQueue.splice(queueIndex, 1);
              console.log('🚫 Removed from cohost queue on leave:', userId);

              // Notify host of updated queue
              const host = Array.from(room.values()).find(
                p => p.role === 'host'
              );
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(
                  JSON.stringify({
                    type: 'cohost_queue_updated',
                    streamId,
                    queue: roomState.cohostQueue.map(r => ({
                      userId: r.userId,
                      timestamp: r.timestamp
                    }))
                  })
                );
              }
            }

            // If leaving user is active guest, clear session and notify host
            if (
              role === 'guest' &&
              roomState.activeGuestId === String(userId)
            ) {
              roomState.activeGuestId = null;

              const host = Array.from(room.values()).find(
                p => p.role === 'host'
              );
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(
                  JSON.stringify({
                    type: 'cohost_ended',
                    streamId,
                    by: 'guest',
                    guestUserId: String(userId)
                  })
                );

                // Always send queue update (even if empty) to clear host UI
                host.ws.send(
                  JSON.stringify({
                    type: 'cohost_queue_updated',
                    streamId,
                    queue: roomState.cohostQueue.map(r => ({
                      userId: r.userId,
                      timestamp: r.timestamp
                    }))
                  })
                );
              }
              console.log('🔚 Active guest left stream, session ended');
            }

            // If leaving user is host, end cohost session and notify guest
            if (role === 'host' && roomState.activeGuestId) {
              const guest = room.get(roomState.activeGuestId);
              if (guest && guest.ws.readyState === WebSocket.OPEN) {
                guest.ws.send(
                  JSON.stringify({
                    type: 'cohost_ended',
                    streamId,
                    by: 'host'
                  })
                );
              }
              roomState.activeGuestId = null;
              console.log('🔚 Host left stream, cohost session ended');
            }

            room.delete(String(userId));
            console.log(`👋 User left stream:`, {
              streamId,
              userId,
              remainingCount: room.size
            });

            if (room.size === 0) {
              rooms.delete(streamId);
              console.log(`🗑️ Room deleted (empty):`, streamId);
            } else {
              broadcastToRoom(streamId, {
                type: 'participant_count_update',
                streamId,
                count: room.size
              });
            }
          }
          currentParticipant = null;
          break;
        }

        case 'webrtc_offer': {
          const { toUserId, fromUserId, sdp } = msg;
          if (!toUserId || !fromUserId || !sdp) {
            console.error('❌ webrtc_offer missing required fields');
            return;
          }

          console.log('📤 Relaying webrtc_offer', {
            from: fromUserId,
            to: toUserId,
            sdpLen: sdp.sdp?.length
          });

          // Special handling: if toUserId is 'host', find the actual host in the room
          let actualToUserId = toUserId;
          if (toUserId === 'host' && currentParticipant) {
            const roomState = rooms.get(currentParticipant.streamId);
            if (roomState) {
              const host = Array.from(roomState.participants.values()).find(
                p => p.role === 'host'
              );
              if (host) {
                actualToUserId = host.userId;
                console.log(
                  '✅ Resolved "host" to actual userId:',
                  actualToUserId
                );
              }
            }
          }

          // Find recipient and relay
          relayToUser(actualToUserId, {
            type: 'webrtc_offer',
            fromUserId: String(fromUserId),
            sdp
          });
          break;
        }

        case 'webrtc_answer': {
          const { toUserId, fromUserId, sdp } = msg;
          if (!toUserId || !fromUserId || !sdp) {
            console.error('❌ webrtc_answer missing required fields');
            return;
          }

          console.log('📤 Relaying webrtc_answer', {
            from: fromUserId,
            to: toUserId,
            sdpLen: sdp.sdp?.length
          });

          relayToUser(toUserId, {
            type: 'webrtc_answer',
            fromUserId: String(fromUserId),
            sdp
          });
          break;
        }

        case 'ice_candidate': {
          const { toUserId, fromUserId, candidate } = msg;
          if (!toUserId || !fromUserId || !candidate) {
            console.error('❌ ice_candidate missing required fields');
            return;
          }

          // Rate limiting: 50/sec, burst 100 - use authenticated userId
          const authenticatedUserId = currentParticipant?.userId || 'anonymous';
          const rateKey = `ice_${authenticatedUserId}`;
          if (!iceCandidateRateLimiter.tryConsume(rateKey, 1)) {
            sendMessage(ws, {
              type: 'error',
              code: 'rate_limited',
              message: 'Too many ICE candidates. Please slow down.'
            });
            metrics.increment('rate_limited_ice_candidate');
            console.warn(
              '⚠️ ICE candidate rate limit exceeded:',
              authenticatedUserId
            );
            return;
          }

          // Special handling: if toUserId is 'host', find the actual host in the room
          let actualToUserId = toUserId;
          if (toUserId === 'host' && currentParticipant) {
            const roomState = rooms.get(currentParticipant.streamId);
            if (roomState) {
              const host = Array.from(roomState.participants.values()).find(
                p => p.role === 'host'
              );
              if (host) {
                actualToUserId = host.userId;
                console.log(
                  '✅ Resolved ICE "host" to actual userId:',
                  actualToUserId
                );
              }
            }
          }

          // Coalesce ICE candidates to reduce signaling overhead
          if (currentParticipant) {
            const roomId = currentParticipant.streamId;
            coalescer.coalesce(
              roomId,
              'ice_candidate',
              {
                type: 'ice_candidate',
                fromUserId: String(fromUserId),
                toUserId: actualToUserId,
                candidate
              },
              messages => {
                // Flush coalesced candidates
                for (const msg of messages) {
                  relayToUser(msg.toUserId, {
                    type: 'ice_candidate',
                    fromUserId: msg.fromUserId,
                    candidate: msg.candidate
                  });
                }
              }
            );
          }
          break;
        }

        case 'cohost_request': {
          // Viewer requests to become Guest (co-host)
          const { streamId, fromUserId } = msg;
          if (!streamId || !fromUserId) {
            console.error('❌ cohost_request missing required fields');
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState) {
            console.error('❌ Room not found:', streamId);
            return;
          }

          // Check if there's already an active guest - auto-decline
          if (roomState.activeGuestId) {
            relayToUser(String(fromUserId), {
              type: 'cohost_declined',
              streamId,
              reason: 'guest_active'
            });
            console.log(
              '🚫 Auto-declined cohost_request (guest already active):',
              fromUserId
            );
            return;
          }

          // Add to queue if not already there
          if (
            !roomState.cohostQueue.find(r => r.userId === String(fromUserId))
          ) {
            roomState.cohostQueue.push({
              userId: String(fromUserId),
              timestamp: Date.now()
            });
            console.log(
              '📥 Added to cohost queue:',
              fromUserId,
              'queue length:',
              roomState.cohostQueue.length
            );
          }

          // Find host and relay request + queue update
          const host = Array.from(roomState.participants.values()).find(
            p => p.role === 'host'
          );
          if (host && host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(
              JSON.stringify({
                type: 'cohost_request',
                fromUserId: String(fromUserId),
                streamId
              })
            );

            // Send updated queue to host
            host.ws.send(
              JSON.stringify({
                type: 'cohost_queue_updated',
                streamId,
                queue: roomState.cohostQueue.map(r => ({
                  userId: r.userId,
                  timestamp: r.timestamp
                }))
              })
            );
            console.log('✅ Relayed cohost_request to host from:', fromUserId);
          }
          break;
        }

        case 'cohost_cancel': {
          // Viewer cancels their co-host request
          const { streamId, userId } = msg;
          if (!streamId || !userId) {
            console.error('❌ cohost_cancel missing required fields');
            return;
          }

          const roomState = rooms.get(streamId);
          if (roomState) {
            const queueIndex = roomState.cohostQueue.findIndex(
              r => r.userId === String(userId)
            );
            if (queueIndex !== -1) {
              roomState.cohostQueue.splice(queueIndex, 1);
              console.log('🚫 Removed from cohost queue:', userId);

              // Notify host of updated queue
              const host = Array.from(roomState.participants.values()).find(
                p => p.role === 'host'
              );
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(
                  JSON.stringify({
                    type: 'cohost_queue_updated',
                    streamId,
                    queue: roomState.cohostQueue.map(r => ({
                      userId: r.userId,
                      timestamp: r.timestamp
                    }))
                  })
                );
              }
            }
          }
          break;
        }

        case 'cohost_accept': {
          // Host accepts a viewer as Guest
          const { streamId, guestUserId } = msg;
          if (!streamId || !guestUserId) {
            console.error('❌ cohost_accept missing required fields');
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState) return;

          // Defensive guard: reject if there's already an active guest (unless it's the same user)
          if (
            roomState.activeGuestId &&
            roomState.activeGuestId !== String(guestUserId)
          ) {
            console.error(
              '❌ Cannot accept cohost, guest already active:',
              roomState.activeGuestId
            );
            return;
          }

          const room = roomState.participants;

          // Remove from queue
          const queueIndex = roomState.cohostQueue.findIndex(
            r => r.userId === String(guestUserId)
          );
          if (queueIndex !== -1) {
            roomState.cohostQueue.splice(queueIndex, 1);
          }

          // Set as active guest
          roomState.activeGuestId = String(guestUserId);

          // Update viewer role to guest
          const participant = room.get(String(guestUserId));
          if (participant) {
            participant.role = 'guest';
            console.log('✅ Promoted viewer to guest:', {
              streamId,
              userId: guestUserId,
              roomSize: room.size
            });

            // Notify the guest
            if (participant.ws.readyState === WebSocket.OPEN) {
              participant.ws.send(
                JSON.stringify({
                  type: 'cohost_accepted',
                  streamId
                })
              );
            }
          }

          // Notify host of updated queue
          const host = Array.from(room.values()).find(p => p.role === 'host');
          if (host && host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(
              JSON.stringify({
                type: 'cohost_queue_updated',
                streamId,
                queue: roomState.cohostQueue.map(r => ({
                  userId: r.userId,
                  timestamp: r.timestamp
                }))
              })
            );
          }
          break;
        }

        case 'cohost_decline': {
          // Host declines a viewer's co-host request
          const { streamId, viewerUserId, reason } = msg;
          if (!streamId || !viewerUserId) {
            console.error('❌ cohost_decline missing required fields');
            return;
          }

          const roomState = rooms.get(streamId);
          if (roomState) {
            // Remove from queue
            const queueIndex = roomState.cohostQueue.findIndex(
              r => r.userId === String(viewerUserId)
            );
            if (queueIndex !== -1) {
              roomState.cohostQueue.splice(queueIndex, 1);

              // Notify host of updated queue
              const host = Array.from(roomState.participants.values()).find(
                p => p.role === 'host'
              );
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(
                  JSON.stringify({
                    type: 'cohost_queue_updated',
                    streamId,
                    queue: roomState.cohostQueue.map(r => ({
                      userId: r.userId,
                      timestamp: r.timestamp
                    }))
                  })
                );
              }
            }
          }

          // Notify the viewer
          relayToUser(String(viewerUserId), {
            type: 'cohost_declined',
            streamId,
            reason
          });
          break;
        }

        case 'cohost_end': {
          // Host or Guest ends co-host session
          const { streamId, by } = msg;
          if (!streamId || !by) {
            console.error('❌ cohost_end missing required fields');
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState || !roomState.activeGuestId) return;

          const guestUserId = roomState.activeGuestId;
          const room = roomState.participants;
          const guest = room.get(guestUserId);

          // Clear active guest
          roomState.activeGuestId = null;

          // Demote guest back to viewer
          if (guest) {
            guest.role = 'viewer';
            console.log('✅ Demoted guest to viewer:', guestUserId);
          }

          // Notify both host and guest
          const host = Array.from(room.values()).find(p => p.role === 'host');
          if (host && host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(
              JSON.stringify({
                type: 'cohost_ended',
                streamId,
                by,
                guestUserId
              })
            );

            // Always send queue update (even if empty) to update host UI
            host.ws.send(
              JSON.stringify({
                type: 'cohost_queue_updated',
                streamId,
                queue: roomState.cohostQueue.map(r => ({
                  userId: r.userId,
                  timestamp: r.timestamp
                }))
              })
            );
          }
          if (guest && guest.ws.readyState === WebSocket.OPEN) {
            guest.ws.send(
              JSON.stringify({
                type: 'cohost_ended',
                streamId,
                by
              })
            );
          }

          console.log('🔚 Cohost session ended by:', by);
          break;
        }

        case 'cohost_mute':
        case 'cohost_unmute':
        case 'cohost_cam_off':
        case 'cohost_cam_on': {
          // Host controls Guest audio/video
          const { streamId, target } = msg;
          if (!streamId || target !== 'guest') {
            console.error('❌ Control message invalid:', msg.type);
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState || !roomState.activeGuestId) {
            console.warn('⚠️ No active guest for control:', msg.type);
            return;
          }

          // Relay control message to guest
          relayToUser(roomState.activeGuestId, {
            type: msg.type,
            streamId
          });
          console.log('📤 Relayed control to guest:', msg.type);
          break;
        }

        case 'game_init': {
          // Phase 5: Host initializes a game
          const { streamId, gameId, version, seed } = msg;
          if (!streamId || !gameId) {
            ws.send(
              JSON.stringify({
                type: 'game_error',
                streamId,
                code: 'INVALID_INIT',
                message: 'Missing streamId or gameId'
              })
            );
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState) {
            ws.send(
              JSON.stringify({
                type: 'game_error',
                streamId,
                code: 'ROOM_NOT_FOUND',
                message: 'Room not found'
              })
            );
            return;
          }

          // Verify sender is host
          const participant = roomState.participants.get(
            currentParticipant?.userId || ''
          );
          if (participant?.role !== 'host') {
            ws.send(
              JSON.stringify({
                type: 'game_error',
                streamId,
                code: 'NOT_HOST',
                message: 'Only host can initialize games'
              })
            );
            return;
          }

          // Initialize game state
          roomState.gameState = {
            version: version || 1,
            gameId,
            seed: seed || Date.now(),
            data: null
          };

          console.log('🎮 Game initialized:', {
            streamId,
            gameId,
            version: roomState.gameState.version
          });

          // Broadcast to all participants
          broadcastToRoom(streamId, {
            type: 'game_init',
            streamId,
            gameId,
            version: roomState.gameState.version,
            seed: roomState.gameState.seed
          });
          break;
        }

        case 'game_state': {
          // Phase 5: Host broadcasts game state update
          const { streamId, version, full, patch } = msg;
          if (!streamId) {
            ws.send(
              JSON.stringify({
                type: 'game_error',
                streamId,
                code: 'INVALID_STATE',
                message: 'Missing streamId'
              })
            );
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState) return;

          // Verify sender is host
          const participant = roomState.participants.get(
            currentParticipant?.userId || ''
          );
          if (participant?.role !== 'host') {
            ws.send(
              JSON.stringify({
                type: 'game_error',
                streamId,
                code: 'NOT_HOST',
                message: 'Only host can update game state'
              })
            );
            return;
          }

          // Update game state
          if (full) {
            roomState.gameState.data = patch;
            roomState.gameState.version =
              version || roomState.gameState.version + 1;
          } else {
            // Shallow merge patch
            roomState.gameState.data = {
              ...roomState.gameState.data,
              ...patch
            };
            roomState.gameState.version =
              version || roomState.gameState.version + 1;
          }

          console.log('🎮 Game state updated:', {
            streamId,
            version: roomState.gameState.version,
            full
          });

          // Coalesce game state updates to reduce broadcast overhead
          coalescer.coalesce(
            streamId,
            'game_state',
            {
              type: 'game_state',
              streamId,
              version: roomState.gameState.version,
              full,
              patch: full ? roomState.gameState.data : patch
            },
            messages => {
              // Only send the latest state (last message in queue)
              if (messages.length > 0) {
                const latestState = messages[messages.length - 1];
                broadcastToRoom(streamId, latestState);
              }
            }
          );
          break;
        }

        case 'game_event': {
          // Phase 5: Guest/Viewer sends game event to host
          const { streamId, type: eventType, payload, from } = msg;
          if (!streamId || !eventType) {
            sendMessage(ws, {
              type: 'game_error',
              streamId,
              code: 'INVALID_EVENT',
              message: 'Missing streamId or event type'
            });
            return;
          }

          const roomState = rooms.get(streamId);
          if (!roomState) return;

          // Use authenticated userId from currentParticipant
          const authenticatedUserId = currentParticipant?.userId;
          if (!authenticatedUserId) {
            console.warn('⚠️ Game event from unauthenticated connection');
            return;
          }

          // Rate limiting: 5 events/sec, burst 10 - use authenticated userId
          const rateKey = `game_${authenticatedUserId}`;
          if (!gameEventRateLimiter.tryConsume(rateKey, 1)) {
            sendMessage(ws, {
              type: 'game_error',
              streamId,
              code: 'rate_limited',
              message: 'Too many game events. Please slow down.'
            });
            metrics.increment('rate_limited_game_event');
            console.warn(
              '⚠️ Game event rate limit exceeded:',
              authenticatedUserId
            );
            return;
          }

          console.log('🎮 Game event received:', {
            streamId,
            eventType,
            from: authenticatedUserId
          });

          // Forward to host for processing
          const host = Array.from(roomState.participants.values()).find(
            p => p.role === 'host'
          );
          if (host && host.ws.readyState === WebSocket.OPEN) {
            sendMessage(host.ws, {
              type: 'game_event',
              streamId,
              eventType,
              payload,
              from: authenticatedUserId
            });
          }

          sendAck(msg.msgId);
          break;
        }

        default:
          console.warn('⚠️ Unknown message type:', msg.type);
      }

      // Track message processing duration
      const duration = Date.now() - msgStart;
      metrics.recordValue('msg_processing_duration_ms', duration);
    });

    ws.on('close', () => {
      console.log('🔌 WebSocket disconnected:', socketId);
      metrics.increment('ws_disconnections_total');

      // Cleanup signaling utilities
      deduplicator.cleanup(socketId);
      if (sessionToken) {
        // Don't remove session immediately - allow reconnection window
        console.log('💾 Session preserved for reconnection:', sessionToken);
      }
      if (currentParticipant) {
        const rateKey = `ice_${currentParticipant.userId}`;
        iceCandidateRateLimiter.cleanup(rateKey);
        const gameKey = `game_${currentParticipant.userId}`;
        gameEventRateLimiter.cleanup(gameKey);
      }

      // Clean up participant
      if (currentParticipant) {
        const { streamId, userId, role } = currentParticipant;
        const roomState = rooms.get(streamId);
        if (roomState) {
          const room = roomState.participants;

          // Remove from cohost queue if present
          const queueIndex = roomState.cohostQueue.findIndex(
            r => r.userId === userId
          );
          if (queueIndex !== -1) {
            roomState.cohostQueue.splice(queueIndex, 1);
            console.log('🚫 Removed from cohost queue on disconnect:', userId);

            // Notify host of updated queue
            const host = Array.from(room.values()).find(p => p.role === 'host');
            if (host && host.ws.readyState === WebSocket.OPEN) {
              host.ws.send(
                JSON.stringify({
                  type: 'cohost_queue_updated',
                  streamId,
                  queue: roomState.cohostQueue.map(r => ({
                    userId: r.userId,
                    timestamp: r.timestamp
                  }))
                })
              );
            }
          }

          // If disconnecting user is active guest, end cohost session
          if (role === 'guest' && roomState.activeGuestId === userId) {
            roomState.activeGuestId = null;

            // Notify host with updated queue
            const host = Array.from(room.values()).find(p => p.role === 'host');
            if (host && host.ws.readyState === WebSocket.OPEN) {
              host.ws.send(
                JSON.stringify({
                  type: 'cohost_ended',
                  streamId,
                  by: 'guest',
                  guestUserId: userId
                })
              );

              // Always send queue update (even if empty) to update host UI
              host.ws.send(
                JSON.stringify({
                  type: 'cohost_queue_updated',
                  streamId,
                  queue: roomState.cohostQueue.map(r => ({
                    userId: r.userId,
                    timestamp: r.timestamp
                  }))
                })
              );
            }
            console.log('🔚 Guest disconnected, cohost session ended');
          }

          // If disconnecting user is host, end cohost session and notify guest
          if (role === 'host' && roomState.activeGuestId) {
            const guest = room.get(roomState.activeGuestId);
            if (guest && guest.ws.readyState === WebSocket.OPEN) {
              guest.ws.send(
                JSON.stringify({
                  type: 'cohost_ended',
                  streamId,
                  by: 'host'
                })
              );
            }
            roomState.activeGuestId = null;
            console.log('🔚 Host disconnected, cohost session ended');
          }

          room.delete(userId);
          console.log(`🚪 ${role.toUpperCase()} left stream:`, {
            streamId,
            userId,
            roomSize: room.size,
            totalRooms: rooms.size
          });

          if (room.size === 0) {
            rooms.delete(streamId);
            console.log(`🗑️ Room deleted (last participant left):`, {
              streamId,
              totalRooms: rooms.size
            });
          } else {
            broadcastToRoom(streamId, {
              type: 'participant_count_update',
              streamId,
              count: room.size
            });
          }
        }
      }
    });

    ws.on('error', err => {
      console.error('❌ WebSocket error:', err);
    });
  });

  // Helper functions
  function relayToUser(userId: string, message: any): boolean {
    // Find user across all rooms
    for (const roomState of Array.from(rooms.values())) {
      const participant = roomState.participants.get(String(userId));
      if (participant && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
        console.log('✅ Relayed to user:', userId, message.type);
        return true;
      }
    }
    console.warn('⚠️ User not found for relay:', userId);
    return false;
  }

  function broadcastToRoom(streamId: string, message: any): void {
    const roomState = rooms.get(streamId);
    if (!roomState) {
      console.warn('⚠️ Room not found for broadcast:', streamId);
      return;
    }
    for (const participant of Array.from(roomState.participants.values())) {
      if (participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
      }
    }
  }

  console.log('✅ WebSocket server initialized at /ws');

  // Periodic connection summary logging (every 60 seconds)
  setInterval(() => {
    if (rooms.size === 0) return; // Don't log if no active rooms

    const summary = {
      timestamp: new Date().toISOString(),
      totalRooms: rooms.size,
      totalParticipants: Array.from(rooms.values()).reduce(
        (sum, r) => sum + r.participants.size,
        0
      ),
      activeGuestSessions: Array.from(rooms.values()).filter(
        r => r.activeGuestId !== null
      ).length
    };
    console.log('📊 Connection Summary:', summary);
  }, 60000);

  // Idle room reaper (every 30 seconds)
  const IDLE_TIMEOUT = 2 * 60 * 1000; // 2 minutes
  const roomLastHostSeen = new Map<string, number>();

  setInterval(() => {
    const now = Date.now();

    for (const [streamId, roomState] of Array.from(rooms.entries())) {
      const hasHost = Array.from(roomState.participants.values()).some(
        p => p.role === 'host'
      );

      if (hasHost) {
        // Reset timeout - host is present
        roomLastHostSeen.set(streamId, now);
      } else {
        // No host - check if timed out
        const lastSeen = roomLastHostSeen.get(streamId) || now;
        if (now - lastSeen > IDLE_TIMEOUT) {
          console.log('🧹 Reaping idle room (no host for 2 min):', streamId);

          // Notify all participants
          for (const participant of Array.from(
            roomState.participants.values()
          )) {
            if (participant.ws.readyState === WebSocket.OPEN) {
              participant.ws.send(
                JSON.stringify({
                  type: 'room_closed',
                  streamId,
                  reason: 'host_timeout'
                })
              );
            }
          }

          // Cleanup room
          coalescer.cleanup(streamId);
          rooms.delete(streamId);
          roomLastHostSeen.delete(streamId);
          metrics.increment('rooms_reaped');
        }
      }
    }

    // Cleanup expired sessions
    sessionManager.cleanupExpired();
  }, 30000);

  // Phase 1: Initialize graceful shutdown
  const gracefulShutdown = new GracefulShutdown(httpServer, wss, 5000);
  gracefulShutdown.init();
  console.log('✅ Graceful shutdown initialized (max 5s drain)');

  return httpServer;
}
