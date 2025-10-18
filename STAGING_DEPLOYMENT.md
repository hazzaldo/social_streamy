# Social Streamy - Wave 1 Staging Deployment Guide

## Overview
Wave 1 migration moves 5 critical WebSocket handlers (`join_stream`, `resume`, `webrtc_offer`, `webrtc_answer`, `ice_candidate`) to the new message router system with production-ready validation, deduplication, rate limiting, and metrics.

## Environment Configuration

### Required Environment Variables

```bash
# Production Security
ALLOWED_ORIGINS="https://your-domain.com,https://www.your-domain.com"
SESSION_SECRET="your-secure-session-secret-here"

# WebRTC TURN Credentials (for mobile/NAT traversal)
TURN_SERVER_URL="turn:openrelay.metered.ca:80"
TURN_USERNAME="your-turn-username"
TURN_PASSWORD="your-turn-password"

# Feature Flags
ROUTER_ENABLED="true"           # Enable Wave 1 router (default: true)
ALLOW_HARNESS="false"           # Disable test harness in production
DEBUG_SDP="false"               # Disable SDP logging in production (default: false)

# Optional - Development Only
NODE_ENV="production"
```

### CORS & WebSocket Origin Validation

The `ALLOWED_ORIGINS` environment variable controls both HTTP CORS and WebSocket origin validation. Set it to a comma-separated list of allowed origins:

```bash
# Example for production
ALLOWED_ORIGINS="https://socialstreamy.com,https://www.socialstreamy.com"

# Example for staging
ALLOWED_ORIGINS="https://staging.socialstreamy.com,https://dev.socialstreamy.com"
```

**Security Note:** In development mode (`NODE_ENV=development`), Replit domains are automatically allowed. In production, **only explicitly listed origins** are permitted.

## Wave 1 Architecture

### Router-First Pattern
```
Incoming WS Message
  ↓
Payload Validation & Sanitization
  ↓
Router.route() with context
  ↓
  ├─→ Wave 1 Handler Found? → Execute → Return Ack/Error
  ├─→ No Handler? → Return false → Legacy Switch Processes
  └─→ Error? → Log & Fallback to Legacy
```

### Migrated Message Types (Wave 1)

| Message Type    | Router Handler          | Features                                          |
|-----------------|-------------------------|---------------------------------------------------|
| join_stream     | handleJoinStream        | Room creation, capacity limits, session tokens    |
| resume          | handleResume            | Session restoration, room migration               |
| webrtc_offer    | handleWebRTCOffer       | SDP relay, host resolution, acks                  |
| webrtc_answer   | handleWebRTCAnswer      | SDP relay, acks                                   |
| ice_candidate   | handleICECandidate      | Rate limiting (50/s burst 100), coalescing (33ms) |

### Key Features Implemented

**Message Router (server/message-router.ts):**
- ✅ Envelope validation (type, msgId required)
- ✅ Per-type payload validation (required fields, max lengths)
- ✅ msgId deduplication (LRU cache, 100 per socket)
- ✅ Per-sender sequence tracking (optional, warns on out-of-order)
- ✅ Normalized acks: `{ type: 'ack', for: msgId, ts }`
- ✅ Normalized errors: `{ type: 'error', code, message, ref }`
- ✅ Labeled metrics: `msgs_handled_total{handled_by="router|legacy", type="..."}`

**Wave 1 Handlers (server/wave1-handlers.ts):**
- ✅ Full legacy parity (field names, logic flow, error codes)
- ✅ Session token propagation (fixes disconnect cleanup)
- ✅ Rate limiting for ICE candidates (50/s burst 100)
- ✅ ICE candidate coalescing (33ms window)
- ✅ Host resolution for guest WebRTC connections
- ✅ Room capacity enforcement (max 100 participants)
- ✅ Game state synchronization on join/resume

## Metrics & Observability

### Prometheus Metrics Endpoint

```bash
GET /metrics
```

**Wave 1 Router Metrics:**
```
# Router handling by type
msgs_handled_total{handled_by="router",type="join_stream"}
msgs_handled_total{handled_by="router",type="resume"}
msgs_handled_total{handled_by="router",type="webrtc_offer"}
msgs_handled_total{handled_by="router",type="webrtc_answer"}
msgs_handled_total{handled_by="router",type="ice_candidate"}

# Legacy handling for non-migrated types
msgs_handled_total{handled_by="legacy",type="cohost_request"}
msgs_handled_total{handled_by="legacy",type="game_event"}
# ... other legacy types

# Error tracking
errors_total{code="invalid_request",type="join_stream"}
errors_total{code="room_full",type="join_stream"}
errors_total{code="SESSION_EXPIRED",type="resume"}
errors_total{code="rate_limited",type="ice_candidate"}

# Ack tracking
acks_total{type="join_stream"}
acks_total{type="resume"}
acks_total{type="webrtc_offer"}
acks_total{type="webrtc_answer"}
acks_total{type="ice_candidate"}

# Deduplication & sequencing
msgs_duplicate_total{type="..."}
msgs_out_of_order_total{type="..."}

# Processing performance
message_processing_duration{type="join_stream"}  # histogram
```

### Health Check Endpoint

```bash
GET /healthz
```

Returns enhanced health status with room summaries, participant counts, and validation status.

## Testing Checklist

### Pre-Deployment Validation

**1. Test Harness (Development Only)**

Access at `/harness` (blocked in production with `ALLOW_HARNESS=false`).

Run automated validation suite:
- ✅ H1: Host local tracks ready (≤2s)
- ✅ H2: Viewer join and offer/answer signaling (≤4s)
- ✅ H3: Video frames received by viewer (≥1 frame within 3s)
- ✅ H4: Guest upgrade flow - Viewer requests → Host approves → bidirectional media (≤8s)
- ✅ H5: Guest fan-out - New viewer receives both Host+Guest streams (≤4s)
- ✅ R1: WebSocket auto-reconnect test (≤8s)
- ✅ R2: ICE restart recovery after network change (≤12s)
- ✅ T1: TURN usage verification (when Force TURN enabled)
- ✅ G1: Game initialization - Host sends game_init, all receive version=1 state
- ✅ G2: Event-driven state mutation - Game event triggers state version increment
- ✅ G3: State sync after reconnection - Client receives full state on WS reconnect
- ✅ G4: Rate limiting - Server throttles rapid game events with game_error

**2. Signaling Stress Tests**

Run stress panel tests:
- ✅ Duplicate Message Detection (deduplication working)
- ✅ ICE Candidate Flood (rate limiting at 50/s burst 100)
- ✅ Session Resume (session token lifecycle)

**3. Metrics Validation**

```bash
# Verify router is handling Wave 1 types
curl https://your-staging-domain.com/metrics | grep "msgs_handled_total"

# Should show:
# msgs_handled_total{handled_by="router",type="join_stream"} N
# msgs_handled_total{handled_by="router",type="resume"} N
# msgs_handled_total{handled_by="router",type="webrtc_offer"} N
# msgs_handled_total{handled_by="router",type="webrtc_answer"} N
# msgs_handled_total{handled_by="router",type="ice_candidate"} N

# Legacy types still handled by legacy switch:
# msgs_handled_total{handled_by="legacy",type="cohost_request"} N
# msgs_handled_total{handled_by="legacy",type="game_event"} N
```

### Playwright E2E Smoke Test

**Test Flow:**
1. Host navigates to `/host/demo`
2. Host clicks "Go Live" → Local camera preview appears
3. Host copies invite link
4. Viewer opens invite link at `/viewer/demo`
5. Viewer sees host video stream playing
6. Viewer clicks "Request Co-host"
7. Host sees co-host request in queue
8. Host clicks "Approve"
9. Viewer upgraded to Guest role
10. Viewer's local camera preview appears
11. Host sees Guest video in PiP
12. Host opens Game Panel
13. Host selects "Caption That Pic!" game
14. Host clicks "Start Round"
15. **Assert:** `gameState.version` increments to 1
16. Host clicks "Next Round"
17. **Assert:** `gameState.version` increments to 2
18. Test PASS

**Expected Results:**
- ✅ All WebRTC signaling uses Wave 1 router handlers
- ✅ Session tokens created and propagated correctly
- ✅ ICE candidates rate-limited and coalesced
- ✅ Game state synchronized across all participants
- ✅ No console errors
- ✅ /metrics shows router handling Wave 1 types

## Rollback Procedure

If Wave 1 regression detected:

**Instant Rollback:**
```bash
# Set environment variable
ROUTER_ENABLED=false

# Restart application
# All Wave 1 types will fall back to legacy switch immediately
```

**Verify Rollback:**
```bash
curl https://your-domain.com/metrics | grep "msgs_handled_total"

# Should show:
# msgs_handled_total{handled_by="legacy",type="join_stream"} N
# msgs_handled_total{handled_by="legacy",type="resume"} N
# ... all types routed through legacy
```

## Monitoring & Alerts

### Recommended Alerts

```yaml
# High error rate
alert: HighRouterErrorRate
expr: rate(errors_total{handled_by="router"}[5m]) > 10
message: "Wave 1 router error rate exceeded threshold"

# Rate limiting triggered frequently
alert: FrequentRateLimiting
expr: rate(errors_total{code="rate_limited"}[1m]) > 5
message: "ICE candidate rate limiting triggered frequently"

# Router fallback errors
alert: RouterFallbackErrors
expr: increase(router_errors[5m]) > 10
message: "Router errors causing fallback to legacy"

# Session token leaks
alert: SessionTokenLeak
expr: increase(session_tokens_active[1h]) > 100 AND deriv(session_tokens_active[1h]) > 0
message: "Session tokens not being cleaned up on disconnect"
```

### Dashboard Metrics

**Key Metrics to Monitor:**
1. Router vs Legacy handling ratio (should be ~5:N where 5 = Wave 1 types)
2. Error rates by code and type
3. Message processing duration (p50, p95, p99)
4. Deduplication hit rate
5. Rate limiting trigger frequency
6. Session token lifecycle (creation, expiration, cleanup)

## Security Considerations

**Wave 1 Improvements:**
- ✅ Session token cleanup on disconnect (prevents stale session attacks)
- ✅ Room capacity limits enforced (max 100 participants)
- ✅ Rate limiting on ICE candidates (prevents signaling DoS)
- ✅ Payload size limits (64KB max)
- ✅ Input sanitization (XSS prevention)
- ✅ Origin validation (CORS + WebSocket)

**Still Required:**
- Database authentication not yet implemented (schema exists)
- Payment processing (Stripe integration planned)
- Content moderation (profanity filter exists but needs tuning)

## Migration Roadmap

**Wave 1 (Current):** ✅ Critical signaling (join, resume, offers, answers, ICE)

**Wave 2 (Next):** 
- cohost_request
- cohost_accept
- cohost_decline
- cohost_end
- cohost_mute/unmute/cam_on/cam_off

**Wave 3 (Future):**
- game_init
- game_event
- leave_stream
- ping/pong (heartbeat)

## Support & Troubleshooting

**Common Issues:**

1. **"Session token expired" on resume**
   - Check SESSION_SECRET is set correctly
   - Verify session lifetime (5 minutes default)
   - Check /metrics for session_tokens_active count

2. **"Room full" errors**
   - Default limit: 100 participants per room
   - Check /healthz for current room sizes
   - Consider increasing limit if needed

3. **ICE candidate rate limiting**
   - Default: 50/sec burst 100
   - Check network conditions (mobile networks generate more candidates)
   - Verify TURN server is configured correctly

4. **Router errors causing fallback**
   - Check logs for "[Router] Handler error"
   - Verify context is being passed correctly
   - Check /metrics for errors_total breakdown

**Debug Mode:**
```bash
# Enable SDP logging (development only)
DEBUG_SDP=true

# Check detailed logs
docker logs <container-id> --tail 1000 | grep "\[Wave1\]"
```

## Contact

For issues or questions:
- Check /healthz endpoint for system status
- Review /metrics for performance data
- Enable DEBUG_SDP temporarily to debug WebRTC issues
- Use ROUTER_ENABLED=false for instant rollback if needed
