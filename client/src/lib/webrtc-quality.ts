/**
 * WebRTC Quality Management
 * 
 * Adaptive encoding, codec preferences, and quality optimization
 * for Social Streamy platform.
 */

// ============================================================================
// 1. Media Constraints
// ============================================================================

/**
 * Talking-head optimized constraints: 720p @ 30fps
 * Voice-optimized audio with echo cancellation
 */
export const MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: "user"
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

// ============================================================================
// 2. Codec Detection & Preferences
// ============================================================================

/**
 * Detect if running on iOS/Safari
 */
export function detectSafariIOS(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  return isIOS || isSafari;
}

/**
 * Get preferred codec list based on platform
 * iOS/Safari: H.264 only (best compatibility)
 * Other: VP9 preferred, H.264 fallback
 */
export function getPreferredCodecs(): string[] {
  return detectSafariIOS()
    ? ["video/H264"]
    : ["video/VP9", "video/H264"];
}

/**
 * Set codec preferences for a peer connection
 * @param pc RTCPeerConnection
 * @param kind "video" or "audio"
 * @param preferredCodecs List of MIME types in preference order
 */
export function setCodecPreferences(
  pc: RTCPeerConnection,
  kind: 'video' | 'audio',
  preferredCodecs: string[]
): void {
  const transceivers = pc.getTransceivers();
  
  for (const transceiver of transceivers) {
    if (transceiver.receiver.track?.kind === kind) {
      const capabilities = RTCRtpReceiver.getCapabilities(kind);
      if (!capabilities) continue;

      const codecs = capabilities.codecs;
      const sortedCodecs: any[] = [];

      // Add preferred codecs first
      for (const preferredMime of preferredCodecs) {
        const matches = codecs.filter(c => 
          c.mimeType.toLowerCase() === preferredMime.toLowerCase()
        );
        sortedCodecs.push(...matches);
      }

      // Add remaining codecs
      for (const codec of codecs) {
        if (!sortedCodecs.some(c => c.mimeType === codec.mimeType)) {
          sortedCodecs.push(codec);
        }
      }

      if (sortedCodecs.length > 0 && transceiver.setCodecPreferences) {
        try {
          transceiver.setCodecPreferences(sortedCodecs);
          console.log(`✅ Codec preferences set for ${kind}:`, sortedCodecs.map(c => c.mimeType));
        } catch (err) {
          console.warn(`⚠️  Failed to set codec preferences for ${kind}:`, err);
        }
      }
    }
  }
}

// ============================================================================
// 3. Adaptive Bitrate Ladder
// ============================================================================

export type QualityProfile = 'high' | 'medium' | 'low';

export interface BitrateProfile {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

/**
 * Three-step adaptive ladder for talking-head streams
 */
export const BITRATE_PROFILES: Record<QualityProfile, BitrateProfile> = {
  high: {
    maxBitrate: 2_500_000,      // 2.5 Mbps
    maxFramerate: 30,
    scaleResolutionDownBy: 1.0   // Full resolution (720p)
  },
  medium: {
    maxBitrate: 1_200_000,      // 1.2 Mbps
    maxFramerate: 30,
    scaleResolutionDownBy: 1.15  // Slight downscale
  },
  low: {
    maxBitrate: 600_000,        // 600 kbps
    maxFramerate: 24,
    scaleResolutionDownBy: 1.5   // More aggressive downscale
  }
};

/**
 * Apply bitrate profile to all video senders
 */
export async function applyBitrateProfile(
  pc: RTCPeerConnection,
  profile: QualityProfile
): Promise<void> {
  const senders = pc.getSenders();
  const config = BITRATE_PROFILES[profile];

  for (const sender of senders) {
    if (sender.track?.kind === 'video') {
      const params = sender.getParameters();
      
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      params.encodings[0].maxBitrate = config.maxBitrate;
      params.encodings[0].maxFramerate = config.maxFramerate;
      params.encodings[0].scaleResolutionDownBy = config.scaleResolutionDownBy;

      try {
        await sender.setParameters(params);
        console.log(`✅ Applied ${profile} profile to sender:`, config);
      } catch (err) {
        console.warn(`⚠️  Failed to set sender parameters:`, err);
      }
    }
  }
}

/**
 * Apply audio OPUS quality settings
 */
export async function applyAudioQuality(
  pc: RTCPeerConnection,
  maxBitrate: number = 96000,  // 64-96kbps
  priority: RTCPriorityType = 'high'
): Promise<void> {
  const senders = pc.getSenders();

  for (const sender of senders) {
    if (sender.track?.kind === 'audio') {
      const params = sender.getParameters();
      
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      params.encodings[0].maxBitrate = maxBitrate;
      params.encodings[0].priority = priority;

      try {
        await sender.setParameters(params);
        console.log(`✅ Applied audio quality: ${maxBitrate}bps, priority: ${priority}`);
      } catch (err) {
        console.warn(`⚠️  Failed to set audio parameters:`, err);
      }
    }
  }
}

// ============================================================================
// 4. Degradation Preferences & Content Hints
// ============================================================================

/**
 * Set degradation preference for video senders
 * "balanced" - balance framerate and resolution
 * "maintain-framerate" - prefer to keep framerate high (good for talking heads)
 * "maintain-resolution" - prefer to keep resolution high (good for screen share)
 */
export function setDegradationPreference(
  pc: RTCPeerConnection,
  preference: RTCDegradationPreference = 'balanced'
): void {
  const senders = pc.getSenders();

  for (const sender of senders) {
    if (sender.track?.kind === 'video') {
      const params = sender.getParameters();
      params.degradationPreference = preference;

      sender.setParameters(params).catch(err => {
        console.warn(`⚠️  Failed to set degradation preference:`, err);
      });
    }
  }
}

/**
 * Set content hint for video track
 * "motion" - optimized for motion (talking heads, video calls)
 * "detail" - optimized for high detail (screen sharing)
 * "text" - optimized for text (presentations)
 */
export function setContentHint(
  track: MediaStreamTrack,
  hint: 'motion' | 'detail' | 'text' = 'motion'
): void {
  if (track.kind === 'video' && 'contentHint' in track) {
    (track as any).contentHint = hint;
    console.log(`✅ Content hint set to: ${hint}`);
  }
}

// ============================================================================
// 5. Keyframe Strategy
// ============================================================================

/**
 * Request a keyframe from receiver (Chrome/Edge only)
 */
export function requestKeyFrame(pc: RTCPeerConnection): void {
  const receivers = pc.getReceivers();
  
  for (const receiver of receivers) {
    if (receiver.track?.kind === 'video') {
      // requestKeyFrame not in types but supported in Chrome
      if (typeof (receiver as any).requestKeyFrame === 'function') {
        try {
          (receiver as any).requestKeyFrame();
          console.log('🔑 Keyframe requested');
        } catch (err) {
          console.warn('⚠️  Keyframe request failed:', err);
        }
      }
    }
  }
}

// ============================================================================
// 6. Adaptive Quality Manager
// ============================================================================

export type HealthStatus = 'good' | 'degraded' | 'recovering' | 'poor';

export interface QualityManagerState {
  currentProfile: QualityProfile;
  healthStatus: HealthStatus;
  degradedTicks: number;
  goodTicks: number;
  lastProfileChange: number;
}

export class AdaptiveQualityManager {
  private pc: RTCPeerConnection;
  private state: QualityManagerState;
  private intervalId?: number;

  // Adaptation thresholds
  private readonly DEGRADE_THRESHOLD = 3;   // 3 ticks (~6s) of degraded
  private readonly UPGRADE_THRESHOLD = 5;   // 5 ticks (~10s) of good
  private readonly MIN_CHANGE_INTERVAL = 5000; // Min 5s between changes

  constructor(pc: RTCPeerConnection, initialProfile: QualityProfile = 'high') {
    this.pc = pc;
    this.state = {
      currentProfile: initialProfile,
      healthStatus: 'good',
      degradedTicks: 0,
      goodTicks: 0,
      lastProfileChange: Date.now()
    };
  }

  /**
   * Update health status and adapt quality if needed
   * Call this from your existing health telemetry system
   */
  updateHealth(health: HealthStatus, packetLoss: number = 0): void {
    this.state.healthStatus = health;

    const now = Date.now();
    const timeSinceLastChange = now - this.state.lastProfileChange;

    // Count consecutive ticks
    if (health === 'degraded' || health === 'poor') {
      this.state.degradedTicks++;
      this.state.goodTicks = 0;

      // Degrade after threshold
      if (
        this.state.degradedTicks >= this.DEGRADE_THRESHOLD &&
        timeSinceLastChange > this.MIN_CHANGE_INTERVAL
      ) {
        this.downgradeQuality();
      }
    } else if (health === 'good') {
      this.state.goodTicks++;
      this.state.degradedTicks = 0;

      // Upgrade after threshold and low packet loss
      if (
        this.state.goodTicks >= this.UPGRADE_THRESHOLD &&
        packetLoss < 0.02 &&
        timeSinceLastChange > this.MIN_CHANGE_INTERVAL
      ) {
        this.upgradeQuality();
      }
    } else {
      // Recovering - reset counters but don't change quality
      this.state.degradedTicks = 0;
      this.state.goodTicks = 0;
    }
  }

  /**
   * Downgrade to next lower quality profile
   */
  private downgradeQuality(): void {
    const profiles: QualityProfile[] = ['high', 'medium', 'low'];
    const currentIndex = profiles.indexOf(this.state.currentProfile);
    
    if (currentIndex < profiles.length - 1) {
      this.state.currentProfile = profiles[currentIndex + 1];
      this.state.lastProfileChange = Date.now();
      this.state.degradedTicks = 0;
      
      applyBitrateProfile(this.pc, this.state.currentProfile);
      console.log(`📉 Quality downgraded to: ${this.state.currentProfile}`);
    }
  }

  /**
   * Upgrade to next higher quality profile
   */
  private upgradeQuality(): void {
    const profiles: QualityProfile[] = ['high', 'medium', 'low'];
    const currentIndex = profiles.indexOf(this.state.currentProfile);
    
    if (currentIndex > 0) {
      this.state.currentProfile = profiles[currentIndex - 1];
      this.state.lastProfileChange = Date.now();
      this.state.goodTicks = 0;
      
      applyBitrateProfile(this.pc, this.state.currentProfile);
      console.log(`📈 Quality upgraded to: ${this.state.currentProfile}`);
    }
  }

  /**
   * Get current quality profile
   */
  getCurrentProfile(): QualityProfile {
    return this.state.currentProfile;
  }

  /**
   * Manually set quality profile
   */
  setProfile(profile: QualityProfile): void {
    if (profile !== this.state.currentProfile) {
      this.state.currentProfile = profile;
      this.state.lastProfileChange = Date.now();
      this.state.degradedTicks = 0;
      this.state.goodTicks = 0;
      
      applyBitrateProfile(this.pc, profile);
      console.log(`🎯 Quality manually set to: ${profile}`);
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }
}

// ============================================================================
// 7. iPhone/Safari Guards
// ============================================================================

/**
 * Get platform-optimized media constraints
 * iOS/Safari: Force H.264-compatible constraints (≤720p30)
 */
export function getPlatformConstraints(): MediaStreamConstraints {
  if (detectSafariIOS()) {
    return {
      video: {
        width: { ideal: 1280 },  // Use ideal, not max (avoid exact match issues)
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: "user"
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
  }
  
  return MEDIA_CONSTRAINTS;
}

// ============================================================================
// 8. Health Monitoring
// ============================================================================

export interface ConnectionStats {
  bitrate: number;
  packetLoss: number;
  rtt: number;
  jitter: number;
  frameRate: number;
  resolution: { width: number; height: number } | null;
}

/**
 * Calculate health status from connection stats
 */
function calculateHealth(stats: ConnectionStats): HealthStatus {
  const { packetLoss, rtt, bitrate } = stats;

  // Poor: High packet loss or very high RTT
  if (packetLoss > 0.10 || rtt > 500) {
    return 'poor';
  }

  // Degraded: Moderate packet loss or high RTT
  if (packetLoss > 0.05 || rtt > 300 || bitrate < 500_000) {
    return 'degraded';
  }

  // Recovering: Low packet loss but not perfect
  if (packetLoss > 0.02) {
    return 'recovering';
  }

  // Good: Everything looks healthy
  return 'good';
}

/**
 * Start health monitoring for a peer connection
 * Polls getStats() and updates quality manager
 * @returns Cleanup function to stop monitoring
 */
export function startHealthMonitoring(
  pc: RTCPeerConnection,
  qualityManager: AdaptiveQualityManager,
  intervalMs: number = 2000
): () => void {
  let lastBytesReceived = 0;
  let lastTimestamp = Date.now();

  const intervalId = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let currentStats: ConnectionStats = {
        bitrate: 0,
        packetLoss: 0,
        rtt: 0,
        jitter: 0,
        frameRate: 0,
        resolution: null
      };

      stats.forEach((report: any) => {
        // Inbound RTP stream (for receiving video)
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const now = Date.now();
          const timeDelta = (now - lastTimestamp) / 1000;

          if (report.bytesReceived !== undefined && timeDelta > 0) {
            const bytesDelta = report.bytesReceived - lastBytesReceived;
            currentStats.bitrate = (bytesDelta * 8) / timeDelta;
            lastBytesReceived = report.bytesReceived;
            lastTimestamp = now;
          }

          if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
            const totalPackets = report.packetsLost + report.packetsReceived;
            currentStats.packetLoss = totalPackets > 0 ? report.packetsLost / totalPackets : 0;
          }

          if (report.jitter !== undefined) {
            currentStats.jitter = report.jitter;
          }

          if (report.framesPerSecond !== undefined) {
            currentStats.frameRate = report.framesPerSecond;
          }

          if (report.frameWidth && report.frameHeight) {
            currentStats.resolution = {
              width: report.frameWidth,
              height: report.frameHeight
            };
          }
        }

        // Outbound RTP stream (for sending video)
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          const now = Date.now();
          const timeDelta = (now - lastTimestamp) / 1000;

          if (report.bytesSent !== undefined && timeDelta > 0) {
            const bytesDelta = report.bytesSent - lastBytesReceived;
            currentStats.bitrate = (bytesDelta * 8) / timeDelta;
            lastBytesReceived = report.bytesSent;
            lastTimestamp = now;
          }

          if (report.framesPerSecond !== undefined) {
            currentStats.frameRate = report.framesPerSecond;
          }
        }

        // Candidate pair (for RTT)
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (report.currentRoundTripTime !== undefined) {
            currentStats.rtt = report.currentRoundTripTime * 1000; // Convert to ms
          }
        }
      });

      // Calculate health and update quality manager
      const health = calculateHealth(currentStats);
      qualityManager.updateHealth(health, currentStats.packetLoss);

    } catch (err) {
      console.warn('⚠️  Health monitoring error:', err);
    }
  }, intervalMs);

  return () => clearInterval(intervalId);
}

// ============================================================================
// 9. Initialization Helper
// ============================================================================

/**
 * Initialize WebRTC quality settings for a peer connection
 * Call this after adding tracks but before creating offer/answer
 * Optionally start health monitoring
 */
export async function initializeQualitySettings(
  pc: RTCPeerConnection,
  localStream: MediaStream,
  initialProfile: QualityProfile = 'high',
  startMonitoring: boolean = true
): Promise<{
  qualityManager: AdaptiveQualityManager;
  stopMonitoring: (() => void) | null;
}> {
  // 1. Set codec preferences
  const preferredCodecs = getPreferredCodecs();
  setCodecPreferences(pc, 'video', preferredCodecs);
  
  // 2. Apply initial bitrate profile
  await applyBitrateProfile(pc, initialProfile);
  
  // 3. Apply audio quality
  await applyAudioQuality(pc);
  
  // 4. Set degradation preference (balanced for talking heads)
  setDegradationPreference(pc, 'balanced');
  
  // 5. Set content hints on tracks
  localStream.getVideoTracks().forEach(track => {
    setContentHint(track, 'motion');
  });
  
  // 6. Create quality manager
  const qualityManager = new AdaptiveQualityManager(pc, initialProfile);
  
  // 7. Start health monitoring if requested
  let stopMonitoring: (() => void) | null = null;
  if (startMonitoring) {
    stopMonitoring = startHealthMonitoring(pc, qualityManager);
  }
  
  console.log('✅ WebRTC quality settings initialized');
  return { qualityManager, stopMonitoring };
}

/**
 * Reapply quality settings after renegotiation
 * Call this after adding/removing tracks and before creating new offer
 */
export async function reapplyQualitySettings(
  pc: RTCPeerConnection,
  qualityManager: AdaptiveQualityManager
): Promise<void> {
  // 1. Set codec preferences again
  const preferredCodecs = getPreferredCodecs();
  setCodecPreferences(pc, 'video', preferredCodecs);
  
  // 2. Reapply current bitrate profile
  const currentProfile = qualityManager.getCurrentProfile();
  await applyBitrateProfile(pc, currentProfile);
  
  // 3. Reapply audio quality
  await applyAudioQuality(pc);
  
  // 4. Set degradation preference
  setDegradationPreference(pc, 'balanced');
  
  console.log('✅ Quality settings reapplied after renegotiation');
}
