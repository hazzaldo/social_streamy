import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";

// In-memory room and participant tracking
interface Participant {
  ws: WebSocket;
  userId: string;
  streamId: string;
  role: 'host' | 'viewer';
}

const rooms = new Map<string, Map<string, Participant>>();

export async function registerRoutes(app: Express): Promise<Server> {
  // Health endpoints
  app.get('/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
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
            rooms.set(streamId, new Map());
          }
          const room = rooms.get(streamId)!;

          // Determine role: first participant is host, others are viewers
          const role = room.size === 0 ? 'host' : 'viewer';

          // Add participant to room
          currentParticipant = { ws, userId: String(userId), streamId, role };
          room.set(String(userId), currentParticipant);

          console.log(`✅ ${role.toUpperCase()} joined stream:`, { streamId, userId, roomSize: room.size });

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

          const room = rooms.get(streamId);
          if (room) {
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

          // Find recipient and relay
          relayToUser(toUserId, {
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

          relayToUser(toUserId, {
            type: 'ice_candidate',
            fromUserId: String(fromUserId),
            candidate
          });
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
        const { streamId, userId } = currentParticipant;
        const room = rooms.get(streamId);
        if (room) {
          room.delete(userId);
          if (room.size === 0) {
            rooms.delete(streamId);
            console.log(`🗑️ Room deleted (participant disconnect):`, streamId);
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
    for (const room of rooms.values()) {
      const participant = room.get(String(userId));
      if (participant && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
        console.log('✅ Relayed to user:', userId, message.type);
        return;
      }
    }
    console.warn('⚠️ User not found for relay:', userId);
  }

  function broadcastToRoom(streamId: string, message: any) {
    const room = rooms.get(streamId);
    if (!room) return;

    for (const participant of room.values()) {
      if (participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(message));
      }
    }
  }

  console.log('✅ WebSocket server initialized at /ws');

  return httpServer;
}
