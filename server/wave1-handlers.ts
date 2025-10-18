import { WebSocket } from 'ws';
import { MessageHandler, MessageContext } from './message-router';

/**
 * Wave 1 Migration: Critical WebSocket handlers
 * 
 * Migrated types: join_stream, resume, webrtc_offer, webrtc_answer, ice_candidate
 * 
 * Features:
 * - Envelope + per-type payload validation (handled by router)
 * - msgId deduplication (handled by router)
 * - Per-sender sequence tracking (handled by router)
 * - Rate limiting for ICE candidates (50/s burst 100)
 * - Coalescing for ICE candidates (33ms window)
 * - Normalized acks { for: msgId } and errors { code, message, ref }
 * - Metrics: msgs_handled_total, errors_total, acks_total
 */

// Helper to send message with backpressure check
function sendMessage(ws: WebSocket, message: any, critical: boolean = true): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error('[Wave1] Send error:', error);
    return false;
  }
}

// Helper to send normalized ack
function sendAck(ws: WebSocket, router: any, msgId?: string, type?: string) {
  if (msgId) {
    sendMessage(ws, {
      type: 'ack',
      for: msgId,
      ts: Date.now()
    }, true);
    if (router && type) {
      router.sendAck(msgId, type);
    }
  }
}

// Helper to send normalized error
function sendError(ws: WebSocket, router: any, code: string, message: string, ref?: string) {
  sendMessage(ws, {
    type: 'error',
    code,
    message,
    ref
  }, true);
  if (router) {
    router.sendError(ws, code, message, ref);
  }
}

/**
 * join_stream handler
 * Validates room capacity, assigns role, creates session token
 */
export const handleJoinStream: MessageHandler = async (ws, msg, context) => {
  const { streamId, userId } = msg;
  const { rooms, sessionManager, broadcastToRoom, currentParticipant: participantRef, metrics } = context;
  
  if (!rooms || !sessionManager) {
    throw new Error('Missing required context: rooms, sessionManager');
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
    console.log('🆕 [Wave1] Room created:', { streamId, totalRooms: rooms.size });
  }
  
  const roomState = rooms.get(streamId)!;
  const room = roomState.participants;

  // Safety: Room capacity limit (max 100 participants)
  if (room.size >= 100 && !room.has(String(userId))) {
    console.warn('⚠️ [Wave1] Room at capacity:', { streamId, size: room.size });
    sendError(ws, null, 'room_full', 'This room has reached maximum capacity (100 participants)', msg.msgId);
    metrics?.increment('errors_total', { code: 'room_full', type: 'join_stream' });
    return;
  }

  // Determine role: first participant is host, others are viewers
  const role = room.size === 0 ? 'host' : 'viewer';

  // Add participant to room and update ref
  const newParticipant = { ws, userId: String(userId), streamId, role };
  room.set(String(userId), newParticipant);
  if (participantRef) {
    (participantRef as any).current = newParticipant;
  }

  // Create session token for reconnection
  const sessionToken = sessionManager.createSession(String(userId), streamId, role);

  console.log(`✅ [Wave1] ${role.toUpperCase()} joined stream:`, { 
    streamId, 
    userId, 
    roomSize: room.size,
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
    const host = Array.from(room.values()).find((p: any) => p.role === 'host');
    if (host && (host as any).ws && (host as any).ws.readyState === WebSocket.OPEN) {
      sendMessage((host as any).ws, {
        type: 'joined_stream',
        streamId,
        userId: String(userId)
      });
    }
  }

  // Send participant count update to all in room
  if (broadcastToRoom) {
    broadcastToRoom(streamId, {
      type: 'participant_count_update',
      streamId,
      count: room.size
    });
  }

  // Send current game state if game is active
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

  // Send ack
  sendAck(ws, null, msg.msgId, 'join_stream');
  metrics?.increment('acks_total', { type: 'join_stream' });
};

/**
 * resume handler
 * Restores session from token, handles room migration
 */
export const handleResume: MessageHandler = async (ws, msg, context) => {
  const { sessionToken } = msg;
  const { rooms, sessionManager, currentParticipant: participantRef, metrics } = context;
  
  if (!rooms || !sessionManager) {
    throw new Error('Missing required context: rooms, sessionManager');
  }

  const session = sessionManager.getSession(sessionToken);
  if (!session) {
    sendError(ws, null, 'SESSION_EXPIRED', 'Session token expired or invalid', msg.msgId);
    metrics?.increment('errors_total', { code: 'SESSION_EXPIRED', type: 'resume' });
    return;
  }

  // Restore session
  const { userId, streamId, role, queuePosition } = session;

  // Check if room still exists
  if (!rooms.has(streamId)) {
    sendMessage(ws, {
      type: 'resume_migrated',
      role: 'viewer',
      reason: 'room_closed'
    });
    metrics?.increment('resume_migrated_total', { reason: 'room_closed' });
    return;
  }

  const roomState = rooms.get(streamId)!;
  
  // Restore participant and update ref
  const restoredParticipant = { ws, userId, streamId, role: role as any };
  roomState.participants.set(userId, restoredParticipant);
  if (participantRef) {
    (participantRef as any).current = restoredParticipant;
  }

  console.log('🔄 [Wave1] Session resumed:', { userId, streamId, role });
  
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

  // Send ack
  sendAck(ws, null, msg.msgId, 'resume');
  metrics?.increment('acks_total', { type: 'resume' });
};

/**
 * webrtc_offer handler
 * Relays SDP offer with special 'host' resolution
 */
export const handleWebRTCOffer: MessageHandler = async (ws, msg, context) => {
  const { toUserId, fromUserId, sdp } = msg;
  const { rooms, currentParticipant, relayToUser, metrics, debugSdp } = context;

  if (!debugSdp) {
    console.log('📤 [Wave1] Relaying webrtc_offer', { from: fromUserId, to: toUserId, sdpType: sdp?.type });
  } else {
    console.log('📤 [Wave1] Relaying webrtc_offer', { from: fromUserId, to: toUserId, sdp });
  }

  // Special handling: if toUserId is 'host', find the actual host in the room
  let actualToUserId = toUserId;
  if (toUserId === 'host' && currentParticipant && rooms) {
    const roomState = rooms.get((currentParticipant as any).streamId);
    if (roomState) {
      const host = Array.from(roomState.participants.values()).find((p: any) => p.role === 'host');
      if (host) {
        actualToUserId = (host as any).userId;
        console.log('✅ [Wave1] Resolved "host" to actual userId:', actualToUserId);
      }
    }
  }

  // Find recipient and relay
  if (relayToUser) {
    relayToUser(actualToUserId, {
      type: 'webrtc_offer',
      fromUserId: String(fromUserId),
      sdp
    });
  }

  // Send ack
  sendAck(ws, null, msg.msgId, 'webrtc_offer');
  metrics?.increment('acks_total', { type: 'webrtc_offer' });
};

/**
 * webrtc_answer handler
 * Relays SDP answer
 */
export const handleWebRTCAnswer: MessageHandler = async (ws, msg, context) => {
  const { toUserId, fromUserId, sdp } = msg;
  const { relayToUser, metrics, debugSdp } = context;

  if (!debugSdp) {
    console.log('📤 [Wave1] Relaying webrtc_answer', { from: fromUserId, to: toUserId, sdpType: sdp?.type });
  } else {
    console.log('📤 [Wave1] Relaying webrtc_answer', { from: fromUserId, to: toUserId, sdp });
  }

  if (relayToUser) {
    relayToUser(toUserId, {
      type: 'webrtc_answer',
      fromUserId: String(fromUserId),
      sdp
    });
  }

  // Send ack
  sendAck(ws, null, msg.msgId, 'webrtc_answer');
  metrics?.increment('acks_total', { type: 'webrtc_answer' });
};

/**
 * ice_candidate handler
 * Rate limits (50/s burst 100), coalesces (33ms), and relays ICE candidates
 */
export const handleICECandidate: MessageHandler = async (ws, msg, context) => {
  const { toUserId, fromUserId, candidate } = msg;
  const { 
    rooms, 
    currentParticipant, 
    iceCandidateRateLimiter, 
    coalescer,
    relayToUser,
    metrics 
  } = context;

  // Rate limiting: 50/sec, burst 100 - use authenticated userId
  if (iceCandidateRateLimiter && currentParticipant) {
    const authenticatedUserId = (currentParticipant as any).userId || 'anonymous';
    const rateKey = `ice_${authenticatedUserId}`;
    
    if (!iceCandidateRateLimiter.tryConsume(rateKey, 1)) {
      sendError(ws, null, 'rate_limited', 'Too many ICE candidates. Please slow down.', msg.msgId);
      metrics?.increment('errors_total', { code: 'rate_limited', type: 'ice_candidate' });
      metrics?.increment('rate_limited_ice_candidate');
      console.warn('⚠️ [Wave1] ICE candidate rate limit exceeded:', authenticatedUserId);
      return;
    }
  }

  // Special handling: if toUserId is 'host', find the actual host in the room
  let actualToUserId = toUserId;
  if (toUserId === 'host' && currentParticipant && rooms) {
    const roomState = rooms.get((currentParticipant as any).streamId);
    if (roomState) {
      const host = Array.from(roomState.participants.values()).find((p: any) => p.role === 'host');
      if (host) {
        actualToUserId = (host as any).userId;
      }
    }
  }

  // Coalesce ICE candidates to reduce signaling overhead
  if (coalescer && currentParticipant) {
    const roomId = (currentParticipant as any).streamId;
    coalescer.coalesce(
      roomId,
      'ice_candidate',
      {
        type: 'ice_candidate',
        fromUserId: String(fromUserId),
        toUserId: actualToUserId,
        candidate
      },
      (messages: any[]) => {
        // Flush coalesced candidates
        for (const coalescedMsg of messages) {
          if (relayToUser) {
            relayToUser(coalescedMsg.toUserId, {
              type: 'ice_candidate',
              fromUserId: coalescedMsg.fromUserId,
              candidate: coalescedMsg.candidate
            });
          }
        }
      }
    );
  } else if (relayToUser) {
    // No coalescer available, relay directly
    relayToUser(actualToUserId, {
      type: 'ice_candidate',
      fromUserId: String(fromUserId),
      candidate
    });
  }

  // Send ack
  sendAck(ws, null, msg.msgId, 'ice_candidate');
  metrics?.increment('acks_total', { type: 'ice_candidate' });
};
