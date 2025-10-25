// Enhanced signaling client utilities

export interface SignalingMessage {
  type: string;
  msgId?: string;
  [key: string]: any;
}

export interface PendingMessage {
  message: SignalingMessage;
  attempts: number;
  timestamp: number;
  timeoutId?: NodeJS.Timeout;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private pendingAcks = new Map<string, PendingMessage>();
  private sessionToken: string | null = null;
  private messageSeq = 0;
  
  // Retry configuration
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [1000, 2000, 4000]; // 1s, 2s, 4s
  
  // Critical message types that require acks
  private readonly CRITICAL_TYPES = [
    'join_stream',
    'webrtc_offer',
    'webrtc_answer',
    'game_event',
    'cohost_request',
    'cohost_accept',
    'cohost_decline'
  ];

  constructor(
    private url: string,
    private onMessage: (msg: any) => void,
    private onError?: (error: Error) => void
  ) {
    // Load session token from sessionStorage
    this.sessionToken = sessionStorage.getItem('sessionToken');
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
          console.log('✅ SignalingClient connected');
          
          // Try to resume session if we have a token
          if (this.sessionToken) {
            this.send({
              type: 'resume',
              sessionToken: this.sessionToken
            });
          }
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          
          // Handle acknowledgments
          if (msg.type === 'ack' && msg.for) {
            this.handleAck(msg.for);
            return;
          }
          
          // Handle join confirmation with session token
          if (msg.type === 'join_confirmed' && msg.sessionToken) {
            this.sessionToken = msg.sessionToken;
            sessionStorage.setItem('sessionToken', msg.sessionToken);
            console.log('💾 Session token saved:', msg.sessionToken);
          }
          
          // Handle session resume
          if (msg.type === 'resume_ok' || msg.type === 'resume_migrated') {
            console.log('🔄 Session resumed:', msg.type);
          }
          
          // Pass message to handler
          this.onMessage(msg);
        };

        this.ws.onerror = (error) => {
          console.error('❌ SignalingClient error:', error);
          this.onError?.(new Error('WebSocket error'));
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('🔌 SignalingClient disconnected');
          // Clean up pending acks
          for (const pending of this.pendingAcks.values()) {
            if (pending.timeoutId) {
              clearTimeout(pending.timeoutId);
            }
          }
          this.pendingAcks.clear();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  send(message: SignalingMessage, requireAck: boolean = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ Cannot send message, WebSocket not connected');
      return;
    }

    // Auto-detect if message type is critical
    if (!requireAck && this.CRITICAL_TYPES.includes(message.type)) {
      requireAck = true;
    }

    // Add message ID for critical messages
    if (requireAck && !message.msgId) {
      message.msgId = this.generateMessageId();
    }

    // Add timestamp and sequence number
    message.ts = Date.now();
    message.seq = ++this.messageSeq;

    // Send message
    this.ws.send(JSON.stringify(message));

    // Track for retry if critical
    if (requireAck && message.msgId) {
      this.trackForRetry(message);
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  clearSession(): void {
    this.sessionToken = null;
    sessionStorage.removeItem('sessionToken');
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private trackForRetry(message: SignalingMessage): void {
    if (!message.msgId) return;

    const pending: PendingMessage = {
      message,
      attempts: 0,
      timestamp: Date.now()
    };

    this.pendingAcks.set(message.msgId, pending);

    // Schedule retry
    this.scheduleRetry(message.msgId);
  }

  private scheduleRetry(msgId: string): void {
    const pending = this.pendingAcks.get(msgId);
    if (!pending) return;

    const delay = this.RETRY_DELAYS[pending.attempts] || this.RETRY_DELAYS[this.RETRY_DELAYS.length - 1];

    pending.timeoutId = setTimeout(() => {
      const p = this.pendingAcks.get(msgId);
      if (!p) return;

      if (p.attempts >= this.MAX_RETRIES) {
        console.error('❌ Message retry limit exceeded:', msgId, p.message.type);
        this.pendingAcks.delete(msgId);
        this.onError?.(new Error(`Message ${p.message.type} failed after ${this.MAX_RETRIES} retries`));
        return;
      }

      console.log(`🔄 Retrying message (attempt ${p.attempts + 1}/${this.MAX_RETRIES}):`, msgId, p.message.type);
      
      p.attempts++;
      
      // Resend with new message ID
      const newMessage = { ...p.message };
      newMessage.msgId = this.generateMessageId();
      
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(newMessage));
      }
      
      // Update tracking with new message ID
      this.pendingAcks.delete(msgId);
      this.pendingAcks.set(newMessage.msgId!, p);
      
      // Schedule next retry
      this.scheduleRetry(newMessage.msgId!);
    }, delay);
  }

  private handleAck(msgId: string): void {
    const pending = this.pendingAcks.get(msgId);
    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingAcks.delete(msgId);
      console.log('✅ Message acknowledged:', msgId, pending.message.type);
    }
  }
}
