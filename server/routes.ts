import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";

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

interface RoomState {
  participants: Map<string, Participant>;
  activeGuestId: string | null;
  cohostQueue: CohostRequest[];
}

const rooms = new Map<string, RoomState>();

export async function registerRoutes(app: Express): Promise<Server> {
  // Health endpoints
  app.get('/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/healthz', (_req, res) => {
    // Enhanced health endpoint with connection summary
    const summary = {
      ok: true,
      timestamp: new Date().toISOString(),
      stats: {
        totalRooms: rooms.size,
        rooms: Array.from(rooms.entries()).map(([streamId, roomState]) => ({
          streamId,
          totalParticipants: roomState.participants.size,
          roles: {
            hosts: Array.from(roomState.participants.values()).filter(p => p.role === 'host').length,
            viewers: Array.from(roomState.participants.values()).filter(p => p.role === 'viewer').length,
            guests: Array.from(roomState.participants.values()).filter(p => p.role === 'guest').length
          },
          activeGuestId: roomState.activeGuestId,
          cohostQueueSize: roomState.cohostQueue.length
        }))
      }
    };
    res.json(summary);
  });

  app.get('/_version', (_req, res) => {
    res.json({
      ts: new Date().toISOString(),
      git: process.env.REPL_SLUG || 'local'
    });
  });

  const httpServer = createServer(app);

  // WebSocket server on /ws path
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    let currentParticipant: Participant | null = null;

    console.log('🔌 New WebSocket connection');

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.error('❌ Failed to parse WebSocket message', e);
        return;
      }

      console.log('📩 WS Message:', msg.type, msg);

      switch (msg.type) {
        case 'ping': {
          // Heartbeat ping - respond with pong for mobile network reliability
          ws.send(JSON.stringify({
            type: 'pong',
            ts: Date.now()
          }));
          break;
        }

        case 'echo': {
          // Echo test for debugging
          ws.send(JSON.stringify({
            type: 'connection_echo_test',
            original: msg,
            timestamp: Date.now()
          }));
          break;
        }

        case 'join_stream': {
          const { streamId, userId } = msg;
          if (!streamId || !userId) {
            console.error('❌ join_stream missing streamId or userId');
            return;
          }

          // Get or create room
          if (!rooms.has(streamId)) {
            rooms.set(streamId, {
              participants: new Map(),
              activeGuestId: null,
              cohostQueue: []
            });
            console.log('🆕 Room created:', {
              streamId,
              totalRooms: rooms.size
            });
          }
          const roomState = rooms.get(streamId)!;
          const room = roomState.participants;

          // Determine role: first participant is host, others are viewers
          const role = room.size === 0 ? 'host' : 'viewer';

          // Add participant to room
          currentParticipant = { ws, userId: String(userId), streamId, role };
          room.set(String(userId), currentParticipant);

          console.log(`✅ ${role.toUpperCase()} joined stream:`, { 
            streamId, 
            userId, 
            roomSize: room.size,
            totalRooms: rooms.size 
          });

          // If viewer joined, notify the host
          if (role === 'viewer') {
            const host = Array.from(room.values()).find(p => p.role === 'host');
            if (host && host.ws.readyState === WebSocket.OPEN) {
              const joinedMsg = {
                type: 'joined_stream',
                streamId,
                userId: String(userId)
              };
              console.log('📤 joined_stream -> host', joinedMsg);
              host.ws.send(JSON.stringify(joinedMsg));
            }
          }

          // Send participant count update to all in room
          broadcastToRoom(streamId, {
            type: 'participant_count_update',
            streamId,
            count: room.size
          });
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
            const queueIndex = roomState.cohostQueue.findIndex(r => r.userId === String(userId));
            if (queueIndex !== -1) {
              roomState.cohostQueue.splice(queueIndex, 1);
              console.log('🚫 Removed from cohost queue on leave:', userId);

              // Notify host of updated queue
              const host = Array.from(room.values()).find(p => p.role === 'host');
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(JSON.stringify({
                  type: 'cohost_queue_updated',
                  streamId,
                  queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
                }));
              }
            }

            // If leaving user is active guest, clear session and notify host
            if (role === 'guest' && roomState.activeGuestId === String(userId)) {
              roomState.activeGuestId = null;
              
              const host = Array.from(room.values()).find(p => p.role === 'host');
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(JSON.stringify({
                  type: 'cohost_ended',
                  streamId,
                  by: 'guest',
                  guestUserId: String(userId)
                }));

                // Always send queue update (even if empty) to clear host UI
                host.ws.send(JSON.stringify({
                  type: 'cohost_queue_updated',
                  streamId,
                  queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
                }));
              }
              console.log('🔚 Active guest left stream, session ended');
            }

            // If leaving user is host, end cohost session and notify guest
            if (role === 'host' && roomState.activeGuestId) {
              const guest = room.get(roomState.activeGuestId);
              if (guest && guest.ws.readyState === WebSocket.OPEN) {
                guest.ws.send(JSON.stringify({
                  type: 'cohost_ended',
                  streamId,
                  by: 'host'
                }));
              }
              roomState.activeGuestId = null;
              console.log('🔚 Host left stream, cohost session ended');
            }

            room.delete(String(userId));
            console.log(`👋 User left stream:`, { streamId, userId, remainingCount: room.size });

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

          console.log('📤 Relaying webrtc_offer', { from: fromUserId, to: toUserId, sdpLen: sdp.sdp?.length });

          // Special handling: if toUserId is 'host', find the actual host in the room
          let actualToUserId = toUserId;
          if (toUserId === 'host' && currentParticipant) {
            const roomState = rooms.get(currentParticipant.streamId);
            if (roomState) {
              const host = Array.from(roomState.participants.values()).find(p => p.role === 'host');
              if (host) {
                actualToUserId = host.userId;
                console.log('✅ Resolved "host" to actual userId:', actualToUserId);
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

          console.log('📤 Relaying webrtc_answer', { from: fromUserId, to: toUserId, sdpLen: sdp.sdp?.length });

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

          // Special handling: if toUserId is 'host', find the actual host in the room
          let actualToUserId = toUserId;
          if (toUserId === 'host' && currentParticipant) {
            const roomState = rooms.get(currentParticipant.streamId);
            if (roomState) {
              const host = Array.from(roomState.participants.values()).find(p => p.role === 'host');
              if (host) {
                actualToUserId = host.userId;
                console.log('✅ Resolved ICE "host" to actual userId:', actualToUserId);
              }
            }
          }

          relayToUser(actualToUserId, {
            type: 'ice_candidate',
            fromUserId: String(fromUserId),
            candidate
          });
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
            console.log('🚫 Auto-declined cohost_request (guest already active):', fromUserId);
            return;
          }

          // Add to queue if not already there
          if (!roomState.cohostQueue.find(r => r.userId === String(fromUserId))) {
            roomState.cohostQueue.push({
              userId: String(fromUserId),
              timestamp: Date.now()
            });
            console.log('📥 Added to cohost queue:', fromUserId, 'queue length:', roomState.cohostQueue.length);
          }

          // Find host and relay request + queue update
          const host = Array.from(roomState.participants.values()).find(p => p.role === 'host');
          if (host && host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(JSON.stringify({
              type: 'cohost_request',
              fromUserId: String(fromUserId),
              streamId
            }));
            
            // Send updated queue to host
            host.ws.send(JSON.stringify({
              type: 'cohost_queue_updated',
              streamId,
              queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
            }));
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
            const queueIndex = roomState.cohostQueue.findIndex(r => r.userId === String(userId));
            if (queueIndex !== -1) {
              roomState.cohostQueue.splice(queueIndex, 1);
              console.log('🚫 Removed from cohost queue:', userId);

              // Notify host of updated queue
              const host = Array.from(roomState.participants.values()).find(p => p.role === 'host');
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(JSON.stringify({
                  type: 'cohost_queue_updated',
                  streamId,
                  queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
                }));
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
          if (roomState.activeGuestId && roomState.activeGuestId !== String(guestUserId)) {
            console.error('❌ Cannot accept cohost, guest already active:', roomState.activeGuestId);
            return;
          }

          const room = roomState.participants;

          // Remove from queue
          const queueIndex = roomState.cohostQueue.findIndex(r => r.userId === String(guestUserId));
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
              participant.ws.send(JSON.stringify({
                type: 'cohost_accepted',
                streamId
              }));
            }
          }

          // Notify host of updated queue
          const host = Array.from(room.values()).find(p => p.role === 'host');
          if (host && host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(JSON.stringify({
              type: 'cohost_queue_updated',
              streamId,
              queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
            }));
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
            const queueIndex = roomState.cohostQueue.findIndex(r => r.userId === String(viewerUserId));
            if (queueIndex !== -1) {
              roomState.cohostQueue.splice(queueIndex, 1);

              // Notify host of updated queue
              const host = Array.from(roomState.participants.values()).find(p => p.role === 'host');
              if (host && host.ws.readyState === WebSocket.OPEN) {
                host.ws.send(JSON.stringify({
                  type: 'cohost_queue_updated',
                  streamId,
                  queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
                }));
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
            host.ws.send(JSON.stringify({
              type: 'cohost_ended',
              streamId,
              by,
              guestUserId
            }));

            // Always send queue update (even if empty) to update host UI
            host.ws.send(JSON.stringify({
              type: 'cohost_queue_updated',
              streamId,
              queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
            }));
          }
          if (guest && guest.ws.readyState === WebSocket.OPEN) {
            guest.ws.send(JSON.stringify({
              type: 'cohost_ended',
              streamId,
              by
            }));
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

        default:
          console.warn('⚠️ Unknown message type:', msg.type);
      }
    });

    ws.on('close', () => {
      console.log('🔌 WebSocket disconnected');
      // Clean up participant
      if (currentParticipant) {
        const { streamId, userId, role } = currentParticipant;
        const roomState = rooms.get(streamId);
        if (roomState) {
          const room = roomState.participants;

          // Remove from cohost queue if present
          const queueIndex = roomState.cohostQueue.findIndex(r => r.userId === userId);
          if (queueIndex !== -1) {
            roomState.cohostQueue.splice(queueIndex, 1);
            console.log('🚫 Removed from cohost queue on disconnect:', userId);

            // Notify host of updated queue
            const host = Array.from(room.values()).find(p => p.role === 'host');
            if (host && host.ws.readyState === WebSocket.OPEN) {
              host.ws.send(JSON.stringify({
                type: 'cohost_queue_updated',
                streamId,
                queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
              }));
            }
          }

          // If disconnecting user is active guest, end cohost session
          if (role === 'guest' && roomState.activeGuestId === userId) {
            roomState.activeGuestId = null;
            
            // Notify host with updated queue
            const host = Array.from(room.values()).find(p => p.role === 'host');
            if (host && host.ws.readyState === WebSocket.OPEN) {
              host.ws.send(JSON.stringify({
                type: 'cohost_ended',
                streamId,
                by: 'guest',
                guestUserId: userId
              }));

              // Always send queue update (even if empty) to update host UI
              host.ws.send(JSON.stringify({
                type: 'cohost_queue_updated',
                streamId,
                queue: roomState.cohostQueue.map(r => ({ userId: r.userId, timestamp: r.timestamp }))
              }));
            }
            console.log('🔚 Guest disconnected, cohost session ended');
          }

          // If disconnecting user is host, end cohost session and notify guest
          if (role === 'host' && roomState.activeGuestId) {
            const guest = room.get(roomState.activeGuestId);
            if (guest && guest.ws.readyState === WebSocket.OPEN) {
              guest.ws.send(JSON.stringify({
                type: 'cohost_ended',
                streamId,
                by: 'host'
              }));
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

    ws.on('error', (err) => {
      console.error('❌ WebSocket error:', err);
    });
  });

  // Helper functions
  function relayToUser(userId: string, message: any) {
    // Find user across all rooms
    for (const roomState of Array.from(rooms.values())) {
      const participant = roomState.participants.get(String(userId));
      if (participant && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
        console.log('✅ Relayed to user:', userId, message.type);
        return;
      }
    }
    console.warn('⚠️ User not found for relay:', userId);
  }

  function broadcastToRoom(streamId: string, message: any) {
    const roomState = rooms.get(streamId);
    if (!roomState) return;

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
      totalParticipants: Array.from(rooms.values()).reduce((sum, r) => sum + r.participants.size, 0),
      activeGuestSessions: Array.from(rooms.values()).filter(r => r.activeGuestId !== null).length
    };
    console.log('📊 Connection Summary:', summary);
  }, 60000);

  return httpServer;
}
