import { WebSocket } from 'ws';
import { MetricsTracker } from './signaling-utils';

// Message envelope schema
interface MessageEnvelope {
  type: string;
  msgId?: string;
  [key: string]: any;
}

// Per-type payload schemas
const MESSAGE_SCHEMAS: Record<string, {
  required: string[];
  optional?: string[];
  maxLengths?: Record<string, number>;
}> = {
  join_stream: {
    required: ['streamId', 'userId'],
    maxLengths: { streamId: 100, userId: 100 }
  },
  resume: {
    required: ['sessionToken'],
    maxLengths: { sessionToken: 200 }
  },
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
  ice_candidate: {
    required: ['targetUserId', 'candidate'],
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
}

// Message router class
export class MessageRouter {
  private handlers: Map<string, MessageHandler> = new Map();
  private metrics: MetricsTracker;
  private debugSdp: boolean;

  constructor(metrics: MetricsTracker, debugSdp: boolean = false) {
    this.metrics = metrics;
    this.debugSdp = debugSdp;
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
      const sanitized = { ...message, sdp: '[REDACTED]' };
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

  // Send normalized ack
  sendAck(ws: WebSocket, type: string, ref?: string) {
    if (ws.readyState === WebSocket.OPEN) {
      const ack = {
        type: `${type}_ack`,
        ...(ref && { ref })
      };
      ws.send(JSON.stringify(ack));
      this.metrics.increment('acks_total', { type });
    }
  }

  // Route incoming message (returns true if handled, false if should fall back to legacy)
  async route(ws: WebSocket, message: MessageEnvelope, socketId: string): Promise<boolean> {
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
      return true; // Handled (rejected)
    }

    // Find handler
    const handler = this.handlers.get(message.type);
    if (!handler) {
      // Schema exists but no handler registered yet - let legacy handle it
      return false;
    }

    // Execute handler
    try {
      const context: MessageContext = {
        socketId,
        metrics: this.metrics,
        debugSdp: this.debugSdp
      };
      await handler(ws, message, context);
      
      // Track processing time
      const duration = Date.now() - startTime;
      this.metrics.recordValue('message_processing_duration', duration, { type: message.type });
      return true; // Handled successfully
    } catch (error) {
      console.error(`[Router] Handler error for ${message.type}:`, error);
      this.sendError(ws, 'internal_error', 'Internal server error', message.msgId);
      this.metrics.increment('errors_total', { code: 'internal_error' });
      return true; // Handled (with error)
    }
  }
}
