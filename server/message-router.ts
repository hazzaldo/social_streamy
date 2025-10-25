import { WebSocket } from 'ws';
import { MetricsTracker, MessageDeduplicator, TokenBucketRateLimiter } from './signaling-utils';

// Message envelope schema
interface MessageEnvelope {
  type: string;
  msgId?: string;
  seq?: number; // Per-sender sequence number
  [key: string]: any;
}

// Per-sender sequence tracking
interface SequenceState {
  lastSeq: number;
  outOfOrder: number; // Count of out-of-order messages
}

// Per-type payload schemas (Wave 1 types aligned with legacy field names)
const MESSAGE_SCHEMAS: Record<string, {
  required: string[];
  optional?: string[];
  maxLengths?: Record<string, number>;
}> = {
  // Wave 1: Critical signaling types
  join_stream: {
    required: ['streamId', 'userId'],
    maxLengths: { streamId: 100, userId: 100 }
  },
  resume: {
    required: ['sessionToken'],
    optional: ['roomId'],
    maxLengths: { sessionToken: 200, roomId: 100 }
  },
  webrtc_offer: {
    required: ['toUserId', 'fromUserId', 'sdp'],
    maxLengths: { toUserId: 100, fromUserId: 100 }
  },
  webrtc_answer: {
    required: ['toUserId', 'fromUserId', 'sdp'],
    maxLengths: { toUserId: 100, fromUserId: 100 }
  },
  ice_candidate: {
    required: ['toUserId', 'fromUserId', 'candidate'],
    maxLengths: { toUserId: 100, fromUserId: 100 }
  },
  
  // Future waves (placeholders)
  ping: {
    required: []
  },
  offer: {
    required: ['targetUserId', 'sdp'],
    maxLengths: { targetUserId: 100 }
  },
  answer: {
    required: ['targetUserId', 'sdp'],
    maxLengths: { targetUserId: 100 }
  },
  cohost_request: {
    required: []
  },
  cohost_cancel: {
    required: []
  },
  cohost_approve: {
    required: ['viewerId'],
    maxLengths: { viewerId: 100 }
  },
  cohost_decline: {
    required: ['viewerId'],
    maxLengths: { viewerId: 100 }
  },
  cohost_offer: {
    required: ['sdp']
  },
  cohost_answer: {
    required: ['sdp']
  },
  cohost_mute: {
    required: []
  },
  cohost_unmute: {
    required: []
  },
  cohost_cam_off: {
    required: []
  },
  cohost_cam_on: {
    required: []
  },
  cohost_end: {
    required: []
  },
  game_init: {
    required: ['gameId', 'initialState'],
    maxLengths: { gameId: 100 }
  },
  game_event: {
    required: ['eventType', 'eventData']
  },
  leave_stream: {
    required: []
  }
};

// Handler function type
export type MessageHandler = (
  ws: WebSocket,
  message: any,
  context: MessageContext
) => Promise<void> | void;

export interface MessageContext {
  socketId: string;
  metrics: MetricsTracker;
  debugSdp: boolean;
  // Wave 1 context additions
  rooms?: Map<string, any>;
  sessionManager?: any;
  currentParticipant?: any;
  sessionToken?: any; // Mutable ref for session token propagation
  iceCandidateRateLimiter?: TokenBucketRateLimiter;
  coalescer?: any;
  relayToUser?: (userId: string, message: any) => void;
  broadcastToRoom?: (streamId: string, message: any) => void;
  sendAck?: (msgId: string, type: string) => void;
  sendError?: (code: string, message: string, ref?: string) => void;
}

// Message router class
export class MessageRouter {
  private handlers: Map<string, MessageHandler> = new Map();
  private metrics: MetricsTracker;
  private debugSdp: boolean;
  private deduplicator: MessageDeduplicator;
  private sequences: Map<string, SequenceState> = new Map();

  constructor(metrics: MetricsTracker, debugSdp: boolean = false) {
    this.metrics = metrics;
    this.debugSdp = debugSdp;
    this.deduplicator = new MessageDeduplicator();
  }

  // Register a handler for a message type
  register(type: string, handler: MessageHandler) {
    this.handlers.set(type, handler);
  }

  // Validate message envelope
  private validateEnvelope(data: any): { valid: boolean; error?: string } {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Message must be an object' };
    }

    if (!data.type || typeof data.type !== 'string') {
      return { valid: false, error: 'Message type is required and must be a string' };
    }

    if (data.type.length > 50) {
      return { valid: false, error: 'Message type too long (max 50 chars)' };
    }

    return { valid: true };
  }

  // Validate per-type payload (only for router-handled types)
  private validatePayload(message: MessageEnvelope): { valid: boolean; error?: string; hasSchema: boolean } {
    const schema = MESSAGE_SCHEMAS[message.type];
    
    // Unknown message types - no schema defined (let legacy handle)
    if (!schema) {
      return { valid: true, hasSchema: false };
    }

    // Check required fields
    for (const field of schema.required) {
      if (!(field in message) || message[field] === null || message[field] === undefined) {
        return { valid: false, error: `Missing required field: ${field}`, hasSchema: true };
      }

      // Type validation for string fields
      if (typeof message[field] === 'string' && message[field].trim() === '') {
        return { valid: false, error: `Field ${field} cannot be empty`, hasSchema: true };
      }
    }

    // Check max lengths
    if (schema.maxLengths) {
      for (const [field, maxLength] of Object.entries(schema.maxLengths)) {
        if (field in message && typeof message[field] === 'string' && message[field].length > maxLength) {
          return { valid: false, error: `Field ${field} exceeds max length ${maxLength}`, hasSchema: true };
        }
      }
    }

    // SDP logging guard
    if (!this.debugSdp && (message.type === 'offer' || message.type === 'answer' || message.type === 'cohost_offer' || message.type === 'cohost_answer')) {
      // Don't log SDP in production
      return { valid: true, hasSchema: true };
    }

    return { valid: true, hasSchema: true };
  }

  // Send normalized error
  sendError(ws: WebSocket, code: string, message: string, ref?: string) {
    if (ws.readyState === WebSocket.OPEN) {
      const error = {
        type: 'error',
        code,
        message,
        ...(ref && { ref })
      };
      ws.send(JSON.stringify(error));
      this.metrics.increment(`errors_total`, { code });
    }
  }

  // Send normalized ack (always requires msgId for proper correlation)
  sendAck(ws: WebSocket, msgId: string, type: string) {
    if (ws.readyState === WebSocket.OPEN) {
      const ack = {
        type: 'ack',
        for: msgId,
        ts: Date.now()
      };
      ws.send(JSON.stringify(ack));
      this.metrics.increment('acks_total', { type });
    }
  }

  // Route incoming message (returns true if handled, false if should fall back to legacy)
  async route(ws: WebSocket, message: MessageEnvelope, socketId: string, context?: Partial<MessageContext>): Promise<boolean> {
    const startTime = Date.now();

    // Validate payload (check if we have a schema for this type)
    const payloadResult = this.validatePayload(message);
    
    // No schema defined - let legacy handle it
    if (!payloadResult.hasSchema) {
      return false;
    }
    
    // Schema exists but validation failed - reject
    if (!payloadResult.valid) {
      this.sendError(ws, 'invalid_request', payloadResult.error!, message.msgId);
      this.metrics.increment('errors_total', { code: 'invalid_request', type: message.type });
      return true; // Handled (rejected)
    }

    // Wave 1: msgId deduplication
    if (message.msgId) {
      if (this.deduplicator.isDuplicate(socketId, message.msgId)) {
        console.log(`[Router] Duplicate msgId detected: ${message.msgId}`);
        this.metrics.increment('msgs_duplicate_total', { type: message.type });
        // Send ack for duplicate to prevent client timeout
        this.sendAck(ws, message.msgId, message.type);
        return true; // Handled (duplicate dropped)
      }
    }

    // Wave 1: Per-sender sequence tracking (optional, warn if out of order)
    if (message.seq !== undefined) {
      const seqKey = socketId;
      if (!this.sequences.has(seqKey)) {
        this.sequences.set(seqKey, { lastSeq: message.seq, outOfOrder: 0 });
      } else {
        const seqState = this.sequences.get(seqKey)!;
        if (message.seq <= seqState.lastSeq) {
          seqState.outOfOrder++;
          console.warn(`[Router] Out-of-order message: expected seq > ${seqState.lastSeq}, got ${message.seq}`);
          this.metrics.increment('msgs_out_of_order_total', { type: message.type });
        }
        seqState.lastSeq = Math.max(seqState.lastSeq, message.seq);
      }
    }

    // Find handler
    const handler = this.handlers.get(message.type);
    if (!handler) {
      // Schema exists but no handler registered yet - let legacy handle it
      return false;
    }

    // Execute handler
    try {
      const fullContext: MessageContext = {
        socketId,
        metrics: this.metrics,
        debugSdp: this.debugSdp,
        ...context
      };
      await handler(ws, message, fullContext);
      
      // Track processing time
      const duration = Date.now() - startTime;
      this.metrics.recordValue('message_processing_duration', duration, { type: message.type });
      return true; // Handled successfully
    } catch (error) {
      console.error(`[Router] Handler error for ${message.type}:`, error);
      this.sendError(ws, 'internal_error', 'Internal server error', message.msgId);
      this.metrics.increment('errors_total', { code: 'internal_error', type: message.type });
      return true; // Handled (with error)
    }
  }

  // Cleanup resources for a disconnected socket
  cleanup(socketId: string) {
    this.deduplicator.cleanup(socketId);
    this.sequences.delete(socketId);
  }
}
