import { WebSocket } from 'ws';

// Message deduplication LRU cache
export class MessageDeduplicator {
  private cache: Map<string, Set<string>> = new Map();
  private readonly maxEntriesPerSocket = 100;

  isDuplicate(socketId: string, msgId: string): boolean {
    if (!this.cache.has(socketId)) {
      this.cache.set(socketId, new Set());
    }
    
    const socketCache = this.cache.get(socketId)!;
    if (socketCache.has(msgId)) {
      return true;
    }
    
    socketCache.add(msgId);
    
    // LRU eviction
    if (socketCache.size > this.maxEntriesPerSocket) {
      const firstEntry = socketCache.values().next().value as string;
      if (firstEntry) {
        socketCache.delete(firstEntry);
      }
    }
    
    return false;
  }

  cleanup(socketId: string) {
    this.cache.delete(socketId);
  }
}

// Token bucket rate limiter
export class TokenBucketRateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();
  
  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
    private burstSize: number = maxTokens
  ) {}

  tryConsume(key: string, tokens: number = 1): boolean {
    const now = Date.now();
    
    if (!this.buckets.has(key)) {
      this.buckets.set(key, {
        tokens: this.burstSize,
        lastRefill: now
      });
    }
    
    const bucket = this.buckets.get(key)!;
    
    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    bucket.tokens = Math.min(this.burstSize, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    
    // Try to consume tokens
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }
    
    return false;
  }

  cleanup(key: string) {
    this.buckets.delete(key);
  }
}

// Session token manager
export class SessionManager {
  private sessions: Map<string, {
    userId: string;
    streamId: string;
    role: 'host' | 'viewer' | 'guest';
    queuePosition?: number;
    expiresAt: number;
  }> = new Map();
  
  private readonly SESSION_LIFETIME = 5 * 60 * 1000; // 5 minutes
  
  createSession(userId: string, streamId: string, role: 'host' | 'viewer' | 'guest'): string {
    const token = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    this.sessions.set(token, {
      userId,
      streamId,
      role,
      expiresAt: Date.now() + this.SESSION_LIFETIME
    });
    return token;
  }
  
  getSession(token: string) {
    const session = this.sessions.get(token);
    if (!session) return null;
    
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    
    return session;
  }
  
  updateSession(token: string, updates: Partial<{ role: string; queuePosition: number }>) {
    const session = this.sessions.get(token);
    if (session) {
      Object.assign(session, updates);
      session.expiresAt = Date.now() + this.SESSION_LIFETIME; // Extend lifetime
    }
  }
  
  removeSession(token: string) {
    this.sessions.delete(token);
  }
  
  cleanupExpired() {
    const now = Date.now();
    for (const [token, session] of Array.from(this.sessions.entries())) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
      }
    }
  }
}

// Metrics tracker
export class MetricsTracker {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  
  increment(metric: string, value: number = 1) {
    this.counters.set(metric, (this.counters.get(metric) || 0) + value);
  }
  
  setGauge(metric: string, value: number) {
    this.gauges.set(metric, value);
  }
  
  recordValue(metric: string, value: number) {
    if (!this.histograms.has(metric)) {
      this.histograms.set(metric, []);
    }
    const values = this.histograms.get(metric)!;
    values.push(value);
    
    // Keep only last 1000 values
    if (values.length > 1000) {
      values.shift();
    }
  }
  
  getPrometheusFormat(): string {
    let output = '';
    
    // Counters
    for (const [name, value] of Array.from(this.counters.entries())) {
      output += `# TYPE ${name} counter\n`;
      output += `${name} ${value}\n\n`;
    }
    
    // Gauges
    for (const [name, value] of Array.from(this.gauges.entries())) {
      output += `# TYPE ${name} gauge\n`;
      output += `${name} ${value}\n\n`;
    }
    
    // Histograms (calculate percentiles)
    for (const [name, values] of Array.from(this.histograms.entries())) {
      if (values.length === 0) continue;
      
      const sorted = [...values].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      
      output += `# TYPE ${name} summary\n`;
      output += `${name}{quantile="0.5"} ${p50}\n`;
      output += `${name}{quantile="0.95"} ${p95}\n`;
      output += `${name}{quantile="0.99"} ${p99}\n`;
      output += `${name}_count ${values.length}\n\n`;
    }
    
    return output;
  }
}

// Message coalescer for high-frequency messages
export class MessageCoalescer {
  private queues: Map<string, any[]> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private readonly COALESCE_WINDOW = 33; // 33ms ~= 30fps
  
  coalesce(
    roomId: string,
    msgType: string,
    message: any,
    flushCallback: (messages: any[]) => void
  ) {
    const key = `${roomId}:${msgType}`;
    
    if (!this.queues.has(key)) {
      this.queues.set(key, []);
    }
    
    this.queues.get(key)!.push(message);
    
    // Clear existing timer and set new one
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
    }
    
    this.timers.set(key, setTimeout(() => {
      const messages = this.queues.get(key) || [];
      if (messages.length > 0) {
        flushCallback(messages);
        this.queues.set(key, []);
      }
      this.timers.delete(key);
    }, this.COALESCE_WINDOW));
  }
  
  cleanup(roomId: string) {
    for (const [key, timer] of Array.from(this.timers.entries())) {
      if (key.startsWith(`${roomId}:`)) {
        clearTimeout(timer);
        this.timers.delete(key);
        this.queues.delete(key);
      }
    }
  }
}

// Backpressure monitor
export class BackpressureMonitor {
  private readonly BUFFER_WARNING_THRESHOLD = 512 * 1024; // 512KB
  private readonly BUFFER_CRITICAL_THRESHOLD = 1024 * 1024; // 1MB
  
  check(ws: WebSocket): 'ok' | 'warning' | 'critical' {
    const buffered = ws.bufferedAmount;
    
    if (buffered > this.BUFFER_CRITICAL_THRESHOLD) {
      return 'critical';
    } else if (buffered > this.BUFFER_WARNING_THRESHOLD) {
      return 'warning';
    }
    
    return 'ok';
  }
  
  shouldDrop(ws: WebSocket, msgType: string): boolean {
    const status = this.check(ws);
    
    if (status === 'critical') {
      // Drop non-critical messages when buffer is full
      const nonCritical = ['ice_candidate', 'participant_count_update', 'game_state'];
      return nonCritical.includes(msgType);
    }
    
    return false;
  }
}

// Auth hook (stubbed)
export interface AuthHook {
  validate(token: string | null): Promise<{ userId: string; isGuest: boolean } | null>;
}

export class DefaultAuthHook implements AuthHook {
  async validate(token: string | null): Promise<{ userId: string; isGuest: boolean }> {
    if (!token) {
      // Generate guest user ID
      const guestId = `guest_${Math.random().toString(36).substring(2, 15)}`;
      return { userId: guestId, isGuest: true };
    }
    
    // Stub: validate token and return userId
    // In production, this would verify JWT or session token
    return { userId: token, isGuest: false };
  }
}

// Payload validator
export class PayloadValidator {
  private readonly MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB
  
  validate(msg: any): { valid: boolean; error?: string } {
    // Check payload size
    const size = JSON.stringify(msg).length;
    if (size > this.MAX_PAYLOAD_SIZE) {
      return { valid: false, error: 'payload_too_large' };
    }
    
    // Validate required fields based on type
    if (!msg.type) {
      return { valid: false, error: 'missing_type' };
    }
    
    // Validate enum types
    const validTypes = [
      'ping', 'echo', 'join_stream', 'leave_stream', 'resume',
      'webrtc_offer', 'webrtc_answer', 'ice_candidate',
      'cohost_request', 'cohost_cancel', 'cohost_accept', 'cohost_decline', 'cohost_end',
      'cohost_mute', 'cohost_unmute', 'cohost_cam_off', 'cohost_cam_on',
      'game_init', 'game_event', 'game_state', 'game_end'
    ];
    
    if (!validTypes.includes(msg.type)) {
      return { valid: false, error: 'unknown_type' };
    }
    
    return { valid: true };
  }
  
  sanitize(msg: any): any {
    // Strip unexpected fields to prevent injection
    const allowedFields = [
      'type', 'msgId', 'roomId', 'senderId', 'ts', 'seq',
      'streamId', 'userId', 'toUserId', 'fromUserId',
      'sdp', 'candidate', 'metadata',
      'gameId', 'seed', 'version', 'patch', 'full', 'eventType', 'eventData',
      'guestUserId', 'viewerUserId', 'reason', 'by', 'target', 'action',
      'authToken', 'sessionToken'
    ];
    
    const sanitized: any = {};
    for (const field of allowedFields) {
      if (msg[field] !== undefined) {
        sanitized[field] = msg[field];
      }
    }
    
    return sanitized;
  }
}
