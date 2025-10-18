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

  // Validate per-type payload
  private validatePayload(message: MessageEnvelope): { valid: boolean; error?: string } {
    const schema = MESSAGE_SCHEMAS[message.type];
    
    // Unknown message types are rejected
    if (!schema) {
      return { valid: false, error: `Unknown message type: ${message.type}` };
    }

    // Check required fields
    for (const field of schema.required) {
      if (!(field in message) || message[field] === null || message[field] === undefined) {
        return { valid: false, error: `Missing required field: ${field}` };
      }

      // Type validation for string fields
      if (typeof message[field] === 'string' && message[field].trim() === '') {
        return { valid: false, error: `Field ${field} cannot be empty` };
      }
    }

    // Check max lengths
    if (schema.maxLengths) {
      for (const [field, maxLength] of Object.entries(schema.maxLengths)) {
        if (field in message && typeof message[field] === 'string' && message[field].length > maxLength) {
          return { valid: false, error: `Field ${field} exceeds max length ${maxLength}` };
        }
      }
    }

    // SDP logging guard
    if (!this.debugSdp && (message.type === 'offer' || message.type === 'answer' || message.type === 'cohost_offer' || message.type === 'cohost_answer')) {
      // Don't log SDP in production
      const sanitized = { ...message, sdp: '[REDACTED]' };
      return { valid: true };
    }

    return { valid: true };
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

  // Route incoming message
  async route(ws: WebSocket, rawMessage: string, socketId: string) {
    const startTime = Date.now();
    let message: MessageEnvelope;

    try {
      message = JSON.parse(rawMessage);
    } catch (e) {
      this.sendError(ws, 'invalid_request', 'Invalid JSON');
      this.metrics.increment('messages_in_total', { type: 'parse_error' });
      return;
    }

    // Validate envelope
    const envelopeResult = this.validateEnvelope(message);
    if (!envelopeResult.valid) {
      this.sendError(ws, 'invalid_request', envelopeResult.error!, message.msgId);
      this.metrics.increment('messages_in_total', { type: 'invalid_envelope' });
      return;
    }

    this.metrics.increment('messages_in_total', { type: message.type });

    // Validate payload
    const payloadResult = this.validatePayload(message);
    if (!payloadResult.valid) {
      this.sendError(ws, 'invalid_request', payloadResult.error!, message.msgId);
      return;
    }

    // Find handler
    const handler = this.handlers.get(message.type);
    if (!handler) {
      this.sendError(ws, 'invalid_request', `No handler for message type: ${message.type}`, message.msgId);
      return;
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
    } catch (error) {
      console.error(`[Router] Handler error for ${message.type}:`, error);
      this.sendError(ws, 'internal_error', 'Internal server error', message.msgId);
      this.metrics.increment('errors_total', { code: 'internal_error' });
    }
  }
}
