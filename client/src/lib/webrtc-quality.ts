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

/**
 * Screen-share optimized constraints: 1080p @ 15-24fps
 * Optimized for text clarity and presentation
 * Disables noise suppression and auto gain control (not needed for screen)
 */
export const SCREEN_SHARE_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 24, max: 24 }
  },
  audio: false  // Screen audio typically not needed
};

/**
 * Set playout delay hint on receiver for low-latency playback
 * @param receiver RTCRtpReceiver to configure
 * @param delayHint Target playout delay in seconds (default: 0.2s)
 */
export function setPlayoutDelayHint(receiver: RTCRtpReceiver, delayHint: number = 0.2): void {
  if ('playoutDelayHint' in receiver) {
    (receiver as any).playoutDelayHint = delayHint;
  }
}

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
 * Detect if browser is Chromium-based (Chrome/Edge)
 */
export function isChromium(): boolean {
  const ua = navigator.userAgent;
  return /Chrome|Chromium|Edg|HeadlessChrome/.test(ua);
}

/**
 * Detect if browser supports scalability mode (SVC)
 * Chrome/Edge support it, Safari/iOS do not
 * 
 * Note: Chrome UA contains "Safari", so we need to check for Chrome/Chromium first
 */
export function supportsScalabilityMode(): boolean {
  const ua = navigator.userAgent;
  
  // Check if running on iOS (no SVC support)
  if (detectSafariIOS()) {
    return false;
  }
  
  // Chrome/Chromium/Edge support scalability mode
  // Check for Chrome/Chromium first before Safari (since Chrome UA includes "Safari")
  return isChromium();
}

/**
 * Feature flags for codec selection
 */
export const CODEC_FEATURES = {
  enableAV1: false,  // AV1 disabled by default (limited browser support)
};

/**
 * Get preferred codec list based on platform
 * TEMPORARY: Force H.264 baseline for all viewers to debug black video issue
 * iOS/Safari: H.264 only (best compatibility)
 * Other: VP9 preferred, H.264 fallback, AV1 if enabled
 */
export function getPreferredCodecs(): string[] {
  // TEMPORARY: Force H.264 for everyone until we fix black video issue
  return ["video/H264"];
  
  /* Original logic:
  const isIOS = detectSafariIOS();
  
  if (isIOS) {
    return ["video/H264"];
  }
  
  const codecs = ["video/VP9", "video/H264"];
  if (CODEC_FEATURES.enableAV1) {
    codecs.unshift("video/AV1");  // Prefer AV1 if enabled
  }
  return codecs;
  */
}

/**
 * Rank codec by profile quality score (higher = better)
 * Returns -1 to reject, 0+ to accept with priority
 */
function rankCodecByProfile(codec: RTCRtpCodecCapability): number {
  const mime = codec.mimeType.toLowerCase();
  const fmtp = codec.sdpFmtpLine?.toLowerCase() || '';
  
  if (mime === 'video/h264') {
    // Prefer Baseline Profile Level 3.1 (42e01f) - widely compatible
    // 42 = Baseline, e0 = Constrained, 1f = Level 3.1
    if (fmtp.includes('profile-level-id=42e01f')) return 100;  // Exact match
    if (fmtp.includes('profile-level-id=42c01f')) return 90;   // Constrained Baseline 3.1
    if (fmtp.includes('profile-level-id=4200')) return 80;     // Baseline (any level)
    if (fmtp.includes('profile-level-id=42e0')) return 70;     // Baseline variants
    if (fmtp.includes('profile-level-id=42')) return 60;       // Baseline family
    
    // Reject High/Main profiles and entries without profile-level-id
    if (fmtp.includes('profile-level-id=64')) return -1;  // High Profile
    if (fmtp.includes('profile-level-id=4d')) return -1;  // Main Profile
    if (!fmtp.includes('profile-level-id')) return -1;    // Ambiguous
    
    return 50;  // Other baseline variants
  }
  
  if (mime === 'video/vp9') {
    // Prefer Profile 0 (8-bit 4:2:0, most compatible)
    if (fmtp.includes('profile-id=0')) return 100;  // Exact match
    if (!fmtp.includes('profile-id')) return 80;    // Assume Profile 0 if not specified
    
    // Reject Profile 1/2/3 (4:2:2, 4:4:4, 10/12-bit)
    if (fmtp.includes('profile-id=1')) return -1;
    if (fmtp.includes('profile-id=2')) return -1;
    if (fmtp.includes('profile-id=3')) return -1;
    
    return 50;
  }
  
  // For AV1 and other codecs, accept all variants
  return 100;
}

/**
 * Set codec preferences for a peer connection with profile hygiene
 * Prioritizes specific codec profiles (H.264 42e01f, VP9 profile 0)
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
      const sortedCodecs: RTCRtpCodecCapability[] = [];

      // Add preferred codecs first (with profile ranking for video)
      for (const preferredMime of preferredCodecs) {
        const matches = codecs
          .filter(c => c.mimeType.toLowerCase() === preferredMime.toLowerCase())
          .map(c => ({ codec: c, rank: kind === 'video' ? rankCodecByProfile(c) : 100 }))
          .filter(({ rank }) => rank >= 0)  // Reject negative ranks
          .sort((a, b) => b.rank - a.rank)  // Sort by rank (descending)
          .map(({ codec }) => codec);
        
        sortedCodecs.push(...matches);
      }

      // Add remaining codecs (with profile ranking for video)
      for (const codec of codecs) {
        const alreadyAdded = sortedCodecs.some(c => 
          c.mimeType === codec.mimeType && 
          c.sdpFmtpLine === codec.sdpFmtpLine
        );
        
        if (!alreadyAdded) {
          const rank = kind === 'video' ? rankCodecByProfile(codec) : 100;
          if (rank >= 0) {  // Only add non-rejected codecs
            sortedCodecs.push(codec);
          }
        }
      }

      if (sortedCodecs.length > 0 && transceiver.setCodecPreferences) {
        try {
          transceiver.setCodecPreferences(sortedCodecs);
          const topCodecs = sortedCodecs.slice(0, 3).map(c => {
            const fmtp = c.sdpFmtpLine ? ` (${c.sdpFmtpLine.substring(0, 50)})` : '';
            return `${c.mimeType}${fmtp}`;
          }).join(', ');
          console.log(`✅ Codec preferences set for ${kind}: ${topCodecs}`);
        } catch (err) {
          console.warn(`⚠️  Failed to set codec preferences for ${kind}:`, err);
        }
      }
    }
  }
}

/**
 * Add video track to peer connection
 * TEMPORARY: Simplified single-layer H.264 to debug black video issue
 * 
 * Reuses existing transceivers during renegotiation to avoid SDP bloat
 * 
 * @param pc RTCPeerConnection
 * @param videoTrack MediaStreamTrack (video)
 * @param stream MediaStream containing the track
 * @returns RTCRtpSender for further configuration
 */
export async function addVideoTrackWithSimulcast(
  pc: RTCPeerConnection,
  videoTrack: MediaStreamTrack,
  stream: MediaStream,
  contentHint: 'motion' | 'detail' | 'text' = 'motion'
): Promise<RTCRtpSender> {
  // TEMPORARY: Disable simulcast/SVC, use simple single-layer H.264
  
  // Set contentHint on track for encoder optimization
  if ('contentHint' in videoTrack) {
    (videoTrack as any).contentHint = contentHint;
  }

  // Check for existing video transceiver to reuse (for renegotiation)
  const transceivers = pc.getTransceivers();
  const existingVideoTransceiver = transceivers.find(
    t => t.receiver.track?.kind === 'video' && 
         (!t.sender.track || t.sender.track.readyState === 'ended')
  );

  let transceiver: RTCRtpTransceiver;
  let sender: RTCRtpSender;
  
  if (existingVideoTransceiver) {
    // Reuse existing transceiver
    await existingVideoTransceiver.sender.replaceTrack(videoTrack);
    existingVideoTransceiver.direction = "sendonly";
    transceiver = existingVideoTransceiver;
    sender = existingVideoTransceiver.sender;
    console.log("✅ Reused existing video transceiver");
  } else {
    // Create new transceiver with sendonly direction
    transceiver = pc.addTransceiver(videoTrack, {
      direction: "sendonly",
      streams: [stream]
    });
    sender = transceiver.sender;
    console.log("✅ Created new video transceiver");
  }
  
  console.log("[HOST] tx mid", transceiver.mid);
  return sender;
}

// ============================================================================
// 3. Adaptive Bitrate Ladder
// ============================================================================

export type QualityProfile = 'high' | 'medium' | 'low' | 'screen-share';

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
  },
  'screen-share': {
    maxBitrate: 3_000_000,      // 3 Mbps for screen detail
    maxFramerate: 24,            // Lower framerate for presentations
    scaleResolutionDownBy: 1.0   // Full resolution (1080p)
  }
};

/**
 * Apply bitrate profile to all video senders
 * Handles both simulcast (multiple encodings) and single-layer streams
 * Includes scalabilityMode for Chrome/Edge with VP9/AV1 (single-layer only)
 */
export async function applyBitrateProfile(
  pc: RTCPeerConnection,
  profile: QualityProfile
): Promise<void> {
  const senders = pc.getSenders();
  const config = BITRATE_PROFILES[profile];
  const useScalabilityMode = supportsScalabilityMode();

  for (const sender of senders) {
    if (sender.track?.kind === 'video') {
      const params = sender.getParameters();
      
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      // Detect simulcast (multiple encodings with RIDs)
      const isSimulcast = params.encodings.length > 1 && 
                          params.encodings.some(e => 'rid' in e);

      if (isSimulcast) {
        // Simulcast mode: Adjust all layers proportionally
        // Don't override RID-based configs, just adjust bitrate/framerate
        for (const encoding of params.encodings) {
          // Scale each layer's bitrate based on its existing scaleResolutionDownBy
          const layerScale = encoding.scaleResolutionDownBy || 1.0;
          // Higher scale = lower quality layer, so inverse relationship
          const bitrateMultiplier = 1.0 / (layerScale * layerScale);
          
          encoding.maxBitrate = Math.floor(config.maxBitrate * bitrateMultiplier);
          encoding.maxFramerate = config.maxFramerate;
          // Keep existing scaleResolutionDownBy for each layer (set during addTransceiver)
        }
      } else {
        // Single-layer mode: Use standard approach
        params.encodings[0].maxBitrate = config.maxBitrate;
        params.encodings[0].maxFramerate = config.maxFramerate;
        params.encodings[0].scaleResolutionDownBy = config.scaleResolutionDownBy;

        // Add scalability mode for Chrome/Edge (L1T3 = 1 spatial layer, 3 temporal layers)
        // Only for single-layer (not simulcast - RID and scalabilityMode are mutually exclusive)
        if (useScalabilityMode) {
          (params.encodings[0] as any).scalabilityMode = 'L1T3';
        }
      }

      try {
        await sender.setParameters(params);
        if (isSimulcast) {
          console.log(`✅ Applied ${profile} profile to simulcast sender (${params.encodings.length} layers)`);
        } else {
          console.log(`✅ Applied ${profile} profile to single-layer sender:`, {
            ...config,
            scalabilityMode: useScalabilityMode ? 'L1T3' : 'none'
          });
        }
      } catch (err) {
        console.warn(`⚠️  Failed to set sender parameters:`, err);
      }
    }
  }
}

/**
 * Enable OPUS FEC and DTX in SDP for audio resilience
 * FEC (Forward Error Correction): Allows receiver to reconstruct lost packets
 * DTX (Discontinuous Transmission): Reduces bandwidth during silence
 * 
 * Call this on SDP before setLocalDescription/setRemoteDescription
 */
export function enableOpusFecDtx(sdp: string): string {
  const lines = sdp.split('\r\n');
  let opusPayloadType: string | null = null;
  
  // Find OPUS payload type
  for (const line of lines) {
    if (line.includes('opus/48000')) {
      const match = line.match(/rtpmap:(\d+)\s+opus/i);
      if (match) {
        opusPayloadType = match[1];
        break;
      }
    }
  }
  
  if (!opusPayloadType) {
    console.warn('⚠️  OPUS codec not found in SDP');
    return sdp;
  }
  
  // Find or create fmtp line for OPUS
  let fmtpLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
      fmtpLineIndex = i;
      break;
    }
  }
  
  if (fmtpLineIndex >= 0) {
    // Update existing fmtp line
    let fmtp = lines[fmtpLineIndex];
    if (!fmtp.includes('useinbandfec=')) {
      fmtp += ';useinbandfec=1';
    }
    if (!fmtp.includes('usedtx=')) {
      fmtp += ';usedtx=1';
    }
    lines[fmtpLineIndex] = fmtp;
  } else {
    // Create new fmtp line (insert after rtpmap)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`rtpmap:${opusPayloadType}`)) {
        lines.splice(i + 1, 0, `a=fmtp:${opusPayloadType} useinbandfec=1;usedtx=1`);
        break;
      }
    }
  }
  
  const result = lines.join('\r\n');
  console.log('✅ OPUS FEC/DTX enabled (useinbandfec=1, usedtx=1)');
  return result;
}

/**
 * Apply audio OPUS quality settings
 * Audio-first strategy: prioritize audio on degraded connections
 */
export async function applyAudioQuality(
  pc: RTCPeerConnection,
  maxBitrate: number = 96000,  // 64-96kbps for talking-head
  priority: RTCPriorityType = 'high',
  ptime: number = 20  // 20ms packet time
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
      
      // Set ptime (packet time) for OPUS - 20ms is optimal for voice
      if ('ptime' in params.encodings[0]) {
        (params.encodings[0] as any).ptime = ptime;
      }

      try {
        await sender.setParameters(params);
        console.log(`✅ Applied audio quality: ${maxBitrate}bps, priority: ${priority}, ptime: ${ptime}ms`);
      } catch (err) {
        console.warn(`⚠️  Failed to set audio parameters:`, err);
      }
    }
  }
}

/**
 * Raise audio priority on degraded connection (audio-first strategy)
 * Temporarily prioritize audio and allow video to scale down
 */
export async function raiseAudioPriorityOnDegraded(
  pc: RTCPeerConnection,
  isDegraded: boolean
): Promise<void> {
  if (isDegraded) {
    // Keep audio at high priority and use maintain-framerate for video
    // This allows video quality to drop while maintaining audio clarity
    await applyAudioQuality(pc, 96000, 'high');
    setDegradationPreference(pc, 'maintain-framerate'); // Prefer smooth video over resolution
    console.log('🔊 Audio-first mode activated (degraded connection)');
  } else {
    // Restore balanced degradation
    await applyAudioQuality(pc, 96000, 'high');
    setDegradationPreference(pc, 'balanced');
    console.log('🔊 Audio priority restored to normal');
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
 * Fallback to sender.generateKeyFrame() on Chromium
 * 
 * Use after:
 * - Guest approved / joined
 * - Renegotiation complete
 * - Network recovered
 * - Viewer joins
 */
export function requestKeyFrame(pc: RTCPeerConnection): void {
  let keyframeRequested = false;
  const receivers = pc.getReceivers();
  
  // Try receiver.requestKeyFrame() first (preferred)
  for (const receiver of receivers) {
    if (receiver.track?.kind === 'video') {
      if (typeof (receiver as any).requestKeyFrame === 'function') {
        try {
          (receiver as any).requestKeyFrame();
          console.log('🔑 Keyframe requested from receiver');
          keyframeRequested = true;
        } catch (err) {
          console.warn('⚠️  Receiver keyframe request failed:', err);
        }
      }
    }
  }

  // Fallback to sender.generateKeyFrame() on Chromium
  if (!keyframeRequested) {
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        if (typeof (sender as any).generateKeyFrame === 'function') {
          try {
            (sender as any).generateKeyFrame();
            console.log('🔑 Keyframe generated from sender (fallback)');
            keyframeRequested = true;
          } catch (err) {
            console.warn('⚠️  Sender keyframe generation failed:', err);
          }
        }
      }
    }
  }

  if (!keyframeRequested) {
    console.warn('⚠️  Keyframe request not supported on this platform');
  }
}

/**
 * Request keyframe on connection recovery
 * Triggers faster first-frame after network events
 */
export function requestKeyFrameOnRecovery(
  pc: RTCPeerConnection,
  reason: 'guest_joined' | 'renegotiation' | 'network_recovered' | 'viewer_joined'
): void {
  console.log(`🔑 Requesting keyframe: ${reason}`);
  requestKeyFrame(pc);
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

interface StreamFrameTracking {
  framesDecoded: number;
  lastUpdateTime: number;
}

export class AdaptiveQualityManager {
  private pc: RTCPeerConnection;
  private state: QualityManagerState;
  private intervalId?: number;
  private lastFps: number = 0;

  // Frozen frame detection (per-stream tracking)
  private streamFrameTracking: Map<string, StreamFrameTracking> = new Map();
  private readonly FROZEN_FRAME_THRESHOLD = 2000;  // 2 seconds without new frames

  // Adaptation thresholds - smarter rules for stability
  private readonly DEGRADE_THRESHOLD = 3;   // 3 ticks (~6s) of degraded
  private readonly UPGRADE_THRESHOLD = 7;   // 7 ticks (~14s) of good (10-15s range)
  private readonly MIN_DWELL_TIME = 8000;   // Min 8s dwell before next change (prevents ping-pong)
  
  // Transport stability: pause downshifts after connectivity events
  private downshiftPausedUntil: number = 0;
  private readonly DOWNSHIFT_PAUSE_DURATION = 5000;  // 5 seconds
  
  // Candidate flip detection: track relay→srflx/host transitions
  private lastCandidatePairType: string | null = null;

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
  updateHealth(health: HealthStatus, packetLoss: number = 0, fps: number = 0): void {
    this.state.healthStatus = health;
    this.lastFps = fps;

    const now = Date.now();
    const timeSinceLastChange = now - this.state.lastProfileChange;

    // Count consecutive ticks
    if (health === 'degraded' || health === 'poor') {
      this.state.degradedTicks++;
      this.state.goodTicks = 0;

      // Downshift after 3 consecutive bad ticks (≈6s) with min 8s dwell
      // Also check if downshifts are paused (transport stability)
      if (
        this.state.degradedTicks >= this.DEGRADE_THRESHOLD &&
        timeSinceLastChange >= this.MIN_DWELL_TIME &&
        now >= this.downshiftPausedUntil
      ) {
        this.downgradeQuality();
      } else if (now < this.downshiftPausedUntil) {
        console.log(`⏸️  Downshift paused for transport stability (${Math.ceil((this.downshiftPausedUntil - now) / 1000)}s remaining)`);
      }
    } else if (health === 'good') {
      this.state.goodTicks++;
      this.state.degradedTicks = 0;

      // Upshift after 10-15s good + loss <2% and fps ≥ 28 with min 8s dwell
      if (
        this.state.goodTicks >= this.UPGRADE_THRESHOLD &&
        packetLoss < 0.02 &&
        fps >= 28 &&
        timeSinceLastChange >= this.MIN_DWELL_TIME
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
  private async downgradeQuality(): Promise<void> {
    const profiles: QualityProfile[] = ['high', 'medium', 'low'];
    const currentIndex = profiles.indexOf(this.state.currentProfile);
    
    if (currentIndex < profiles.length - 1) {
      this.state.currentProfile = profiles[currentIndex + 1];
      this.state.lastProfileChange = Date.now();
      this.state.degradedTicks = 0;
      
      await applyBitrateProfile(this.pc, this.state.currentProfile);
      
      // Audio-first strategy: prioritize audio when degraded
      await raiseAudioPriorityOnDegraded(this.pc, true);
      
      console.log(`📉 Quality downgraded to: ${this.state.currentProfile}`);
    }
  }

  /**
   * Upgrade to next higher quality profile
   */
  private async upgradeQuality(): Promise<void> {
    const profiles: QualityProfile[] = ['high', 'medium', 'low'];
    const currentIndex = profiles.indexOf(this.state.currentProfile);
    
    if (currentIndex > 0) {
      this.state.currentProfile = profiles[currentIndex - 1];
      this.state.lastProfileChange = Date.now();
      this.state.goodTicks = 0;
      
      await applyBitrateProfile(this.pc, this.state.currentProfile);
      
      // Restore normal audio priority when upgraded
      await raiseAudioPriorityOnDegraded(this.pc, false);
      
      console.log(`📈 Quality upgraded to: ${this.state.currentProfile}`);
    }
  }

  /**
   * Check for frozen frames and request keyframe if detected
   * Call this from your monitoring loop with streamId and framesDecoded from getStats()
   * @param streamId Unique identifier for the stream (e.g., report.id or ssrc)
   * @param framesDecoded Current framesDecoded count from inbound-rtp stats
   */
  checkFrozenFrames(streamId: string, framesDecoded: number): void {
    const now = Date.now();
    const tracking = this.streamFrameTracking.get(streamId);
    
    if (!tracking) {
      // First time seeing this stream, initialize tracking
      this.streamFrameTracking.set(streamId, {
        framesDecoded,
        lastUpdateTime: now
      });
      return;
    }
    
    // Handle counter reset (new SSRC after renegotiation)
    if (framesDecoded < tracking.framesDecoded) {
      // Counter reset detected, restart tracking
      this.streamFrameTracking.set(streamId, {
        framesDecoded,
        lastUpdateTime: now
      });
      return;
    }
    
    if (framesDecoded > tracking.framesDecoded) {
      // Frames are progressing, update tracking
      this.streamFrameTracking.set(streamId, {
        framesDecoded,
        lastUpdateTime: now
      });
    } else if (framesDecoded === tracking.framesDecoded) {
      // Frames are stalled (including zero-frame streams), check if threshold exceeded
      const stallDuration = now - tracking.lastUpdateTime;
      
      if (stallDuration >= this.FROZEN_FRAME_THRESHOLD) {
        console.warn(`⚠️  Frozen frame detected on stream ${streamId.substring(0, 8)} (${Math.floor(stallDuration/1000)}s stall at ${framesDecoded} frames), requesting keyframe`);
        requestKeyFrame(this.pc);
        // Reset timer to avoid spamming keyframe requests
        this.streamFrameTracking.set(streamId, {
          framesDecoded: tracking.framesDecoded,
          lastUpdateTime: now
        });
      }
    }
  }

  /**
   * Get current quality profile
   */
  getCurrentProfile(): QualityProfile {
    return this.state.currentProfile;
  }

  /**
   * Pause downshifts for transport stability
   * Call this after ICE restart, connection state changes, or other connectivity events
   * @param duration Duration in ms (default: 5000ms)
   */
  pauseDownshifts(duration: number = this.DOWNSHIFT_PAUSE_DURATION): void {
    this.downshiftPausedUntil = Date.now() + duration;
    console.log(`⏸️  Downshifts paused for ${duration / 1000}s (transport stability)`);
  }

  /**
   * Detect relay→srflx/host candidate flips for transport observability
   * Logs when connection switches from TURN (relay) to STUN/direct (srflx/host)
   * @param stats RTCStatsReport from getStats()
   */
  async detectCandidateFlips(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          // Found the active candidate pair
          const localCandidate = stats.get(report.localCandidateId);
          const remoteCandidate = stats.get(report.remoteCandidateId);
          
          if (!localCandidate || !remoteCandidate) continue;
          
          // Determine candidate pair type (relay, srflx, or host)
          const candidateType = localCandidate.candidateType || remoteCandidate.candidateType;
          
          if (this.lastCandidatePairType && this.lastCandidatePairType !== candidateType) {
            // Candidate flip detected!
            if (this.lastCandidatePairType === 'relay' && (candidateType === 'srflx' || candidateType === 'host')) {
              console.log(`🔄 Candidate flip: relay → ${candidateType} (TURN fallback → direct/STUN)`);
            } else if ((this.lastCandidatePairType === 'srflx' || this.lastCandidatePairType === 'host') && candidateType === 'relay') {
              console.log(`🔄 Candidate flip: ${this.lastCandidatePairType} → relay (direct/STUN → TURN fallback)`);
            } else {
              console.log(`🔄 Candidate flip: ${this.lastCandidatePairType} → ${candidateType}`);
            }
          }
          
          this.lastCandidatePairType = candidateType;
          break; // Only one active pair
        }
      }
    } catch (err) {
      // Silently fail - this is just observability
    }
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
// 7. Scene-Based Profiles
// ============================================================================

export type SceneProfile = 'talking-head' | 'screen-share' | 'data-saver';

export interface SceneConstraints {
  video: MediaTrackConstraints;
  audio: MediaTrackConstraints;
  bitrateProfile: QualityProfile;
  contentHint: 'motion' | 'detail' | 'text';
  degradationPreference: RTCDegradationPreference;
  maxBitrateCap?: number;
}

/**
 * Scene-based profile configurations
 */
export const SCENE_PROFILES: Record<SceneProfile, SceneConstraints> = {
  'talking-head': {
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    bitrateProfile: 'high',
    contentHint: 'motion',
    degradationPreference: 'balanced'
  },
  'screen-share': {
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 15, max: 24 }
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: false,  // Preserve audio fidelity for presentations
      autoGainControl: false
    },
    bitrateProfile: 'high',
    contentHint: 'text',
    degradationPreference: 'maintain-resolution'
  },
  'data-saver': {
    video: {
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 360 },
      frameRate: { ideal: 24, max: 24 }
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    bitrateProfile: 'medium',
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
    maxBitrateCap: 1_000_000  // Cap High at 1 Mbps, start at Medium
  }
};

/**
 * Apply scene-based profile to peer connection
 * Switch profiles without renegotiation using setParameters
 */
export async function applySceneProfile(
  pc: RTCPeerConnection,
  localStream: MediaStream,
  scene: SceneProfile
): Promise<void> {
  const config = SCENE_PROFILES[scene];
  
  // Apply bitrate profile
  await applyBitrateProfile(pc, config.bitrateProfile);
  
  // Apply bitrate cap for data-saver
  if (scene === 'data-saver' && config.maxBitrateCap) {
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        const params = sender.getParameters();
        if (params.encodings && params.encodings[0]) {
          // Cap maximum bitrate
          params.encodings[0].maxBitrate = Math.min(
            params.encodings[0].maxBitrate || config.maxBitrateCap,
            config.maxBitrateCap
          );
          await sender.setParameters(params);
        }
      }
    }
  }
  
  // Set content hint on video tracks
  localStream.getVideoTracks().forEach(track => {
    setContentHint(track, config.contentHint);
  });
  
  // Set degradation preference
  setDegradationPreference(pc, config.degradationPreference);
  
  console.log(`✅ Applied scene profile: ${scene}`, config);
}

// ============================================================================
// 8. iPhone/Safari Guards
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

          // Frozen frame detection (per-stream tracking)
          if (report.framesDecoded !== undefined && report.id) {
            qualityManager.checkFrozenFrames(report.id, report.framesDecoded);
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

      // Calculate health and update quality manager with FPS
      const health = calculateHealth(currentStats);
      qualityManager.updateHealth(health, currentStats.packetLoss, currentStats.frameRate);

      // Detect relay→srflx/host candidate flips for transport observability
      await qualityManager.detectCandidateFlips();

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
  
  // 8. Connection optimizations
  checkTWCCSupport(); // Log TWCC support status
  
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

// ============================================================================
// 10. Connection Optimizations
// ============================================================================

/**
 * Check if TWCC (Transport Wide Congestion Control) is supported/enabled
 * TWCC provides better congestion control by allowing receivers to send feedback
 * about all packets, not just key frames
 * 
 * Returns true if TWCC extension is found in sender capabilities
 */
export function checkTWCCSupport(): boolean {
  try {
    const capabilities = RTCRtpSender.getCapabilities('video');
    if (!capabilities || !capabilities.headerExtensions) {
      return false;
    }
    
    // Look for TWCC header extension
    // URI: http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
    const twccExtension = capabilities.headerExtensions.find(ext => 
      ext.uri === 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01' ||
      ext.uri.includes('transport-wide-cc-extensions')
    );
    
    if (twccExtension) {
      console.log('✅ TWCC (Transport Wide Congestion Control) is supported');
      return true;
    } else {
      console.log('⚠️  TWCC not found in sender capabilities');
      return false;
    }
  } catch (err) {
    console.warn('⚠️  Failed to check TWCC support:', err);
    return false;
  }
}

/**
 * Trigger ICE restart to re-enable candidate gathering
 * Useful when connection degrades or needs recovery
 * @param pc RTCPeerConnection to restart
 * @param qualityManager Optional quality manager to pause downshifts during restart
 */
export async function restartICE(
  pc: RTCPeerConnection,
  qualityManager?: AdaptiveQualityManager
): Promise<void> {
  try {
    console.log('🔄 Restarting ICE candidate gathering');
    
    // Pause downshifts for transport stability
    if (qualityManager) {
      qualityManager.pauseDownshifts(5000);
    }
    
    // Create offer with iceRestart flag
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    
    console.log('✅ ICE restart initiated');
  } catch (err) {
    console.error('❌ ICE restart failed:', err);
  }
}

/**
 * Create a wrapper for ICE candidate handler that stops forwarding candidates
 * after successful connection
 * 
 * This reduces server load and network traffic by preventing unnecessary candidates
 * after the connection is stable
 * 
 * NOTE: This utility function is available but not yet integrated into Host/Viewer/TestHarness.
 * Integration requires refactoring onicecandidate handlers in those files to use this wrapper.
 * 
 * Example usage (when integrating):
 * ```
 * const cleanup = setupOptimizedCandidateHandler(
 *   pc,
 *   (candidate) => {
 *     ws.send(JSON.stringify({ type: 'ice_candidate', candidate }));
 *   },
 *   'viewer-123'
 * );
 * ```
 * 
 * @param pc RTCPeerConnection to monitor
 * @param onCandidate Callback to forward candidates (e.g., send via WebSocket)
 * @param label Optional label for logging
 * @returns Cleanup function to remove event listeners
 */
export function setupOptimizedCandidateHandler(
  pc: RTCPeerConnection,
  onCandidate: (candidate: RTCIceCandidate) => void,
  label: string = 'peer'
): () => void {
  let shouldForwardCandidates = true;
  
  // Handle ICE candidates
  const candidateHandler = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate && shouldForwardCandidates) {
      onCandidate(event.candidate);
    } else if (event.candidate && !shouldForwardCandidates) {
      console.log(`🔌 ${label}: Suppressing candidate after connection established`);
    }
  };
  
  // Monitor connection state
  const stateHandler = () => {
    const state = pc.connectionState;
    
    // Once connected, stop forwarding new candidates
    if (state === 'connected' && shouldForwardCandidates) {
      shouldForwardCandidates = false;
      console.log(`🔌 ${label}: Connection established, stopping candidate forwarding to save bandwidth`);
    } else if ((state === 'connecting' || state === 'failed' || state === 'disconnected') && !shouldForwardCandidates) {
      // Re-enable if connection is restarting or degrading (ICE restart support)
      shouldForwardCandidates = true;
      console.log(`⚠️  ${label}: Connection ${state}, re-enabling candidate forwarding for ICE restart/recovery`);
    }
  };
  
  pc.addEventListener('icecandidate', candidateHandler);
  pc.addEventListener('connectionstatechange', stateHandler);
  
  // Return cleanup function
  return () => {
    pc.removeEventListener('icecandidate', candidateHandler);
    pc.removeEventListener('connectionstatechange', stateHandler);
  };
}
