# Social Streamy

## Overview
Social Streamy is a WebRTC-based live streaming platform facilitating real-time video broadcasting from hosts to viewers. It uses peer-to-peer WebRTC connections for video and WebSocket for signaling. The platform features a dark-first UI, inspired by modern streaming services, designed for prolonged viewing. The business vision is to create a social, interactive entertainment platform centered around short 1-to-1 live game sessions and optional public co-streams, with monetization based on content support (coins for gifts, super messages, and tips).

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The application employs a "video-first" design philosophy, drawing inspiration from platforms like Twitch and YouTube Live. Key elements include a dark-first color scheme (deep charcoal with vibrant purple accents), minimal cognitive load, Inter font for UI, and JetBrains Mono for technical data, all within a responsive layout that prioritizes video content.

### Technical Implementations
**Frontend:**
- **Framework:** React 18 with TypeScript
- **Routing:** Wouter
- **UI Components:** Radix UI primitives with shadcn/ui
- **Styling:** Tailwind CSS with custom design tokens
- **State Management:** TanStack Query for server state
- **Build Tool:** Vite

**Backend:**
- **Runtime:** Node.js with TypeScript
- **Framework:** Express.js
- **WebSocket:** `ws` library for real-time signaling
- **Database ORM:** Drizzle ORM for PostgreSQL
- **Session Management:** `connect-pg-simple`

**WebRTC Signaling Flow:**
Participants connect via WebSocket. Three roles supported: Host (broadcaster), Guest (co-host with bidirectional media), and Viewer (receive-only). The server maintains in-memory room state and relays signaling messages (offer, answer, ICE candidates) by `userId`. Special 'host' identifier resolves to actual host userId for Guest-to-Host connections.

**Phase 1.1 (Mobile Reliability - Completed):**
- TURN server configuration with both TCP (`turn:`) and TLS (`turns:`) endpoints for NAT traversal
- WebSocket heartbeat: client pings every 25s, server responds with pong to maintain mobile network connections

**Phase 2 (Guest Role - Completed):**
- Guest (co-host) role with bidirectional media exchange between Host and Guest
- Extended signaling protocol: `cohost_request`, `cohost_accept`, `cohost_decline`, `cohost_offer`, `cohost_answer`
- Host auto-accepts cohost requests
- Guest sends offer to 'host' identifier, server resolves to actual host userId

**Phase 3 (Guest Fan-Out - Completed):**
- Host fans out Guest tracks to all Viewers after receiving Guest media
- Renegotiation: Host creates updated offers with both Host and Guest tracks for existing viewers
- Viewers receive and display multiple streams: first stream ID = Host video, second = Guest video
- UI shows 3 video elements: Local Preview (Host), Host Stream (for Viewers), Guest Stream (for Viewers)

**Phase 4 (Co-host Request/Approval UI - Completed):**
- Manual approval workflow: Viewers request co-host, Host approves/declines from queue
- Viewer UI: Request button with state machine (idle → pending → accepted/declined), cancel functionality
- Host UI: Pending request queue with Approve/Decline buttons, active guest controls panel
- Guest controls: Mute/Unmute audio, Camera On/Off, End Co-host session
- Single-guest enforcement: Additional requests queued when guest active, auto-declined when queue full
- Queue management: Server broadcasts queue updates after mutations, cleanup on disconnect/leave
- Control message relay: cohost_mute, cohost_unmute, cohost_cam_off, cohost_cam_on, cohost_ended
- State management: roleRef pattern to track live role in WebSocket handlers, avoiding closure capture issues

**Phase 5 (Game Rails - Completed):**
- Host-authoritative game state synchronization for lightweight interactive games
- Server-side gameState tracking with version-based state sync (full replace or shallow merge)
- Game message handlers: game_init, game_event, game_state with rate limiting (5 events/sec, burst 10)
- Client-side Game Panel UI with game selection, state viewer, and event logging
- Caption competition initial implementation with round management
- Automatic state sync on join/reconnect

**Validation Runner (Automated Testing - Completed):**
- One-click validation suite executing automated test scenarios
- Test scenarios:
  - H1: Host local tracks ready (≤2s)
  - H2: Viewer join and offer/answer signaling (≤4s)
  - H3: Video frames received by viewer (≥1 frame within 3s)
  - H4: Guest upgrade flow - Viewer requests → Host approves → bidirectional media (≤8s)
  - H5: Guest fan-out - New viewer receives both Host+Guest streams (≤4s)
  - R1: WebSocket auto-reconnect test (≤8s)
  - R2: ICE restart recovery after network change (≤12s)
  - T1: TURN usage verification (when Force TURN enabled)
  - G1: Game initialization - Host sends game_init, all receive version=1 state
  - G2: Event-driven state mutation - Game event triggers state version increment
  - G3: State sync after reconnection - Client receives full state on WS reconnect
  - G4: Rate limiting - Server throttles rapid game events with game_error
- Fault injection controls: Force TURN, throttle bitrate, simulate network changes, disable heartbeat
- Telemetry assertions: Bitrate thresholds, RTT limits, frame counting, TURN detection
- Enhanced reporting: Per-test duration metrics, version evolution tracking for game tests, failure logs (last 10 per role)
- Downloadable JSON reports with complete test artifacts
- Server endpoints: /validate (retrieve report), /validate/report (submit), /healthz (includes validation summary)
- CI/CD integration ready via server-side report storage and retrieval

### Feature Specifications
- **Core Objects & Roles:** User (viewer/creator), Creator (can go live, receive gifts, accept game requests), Session (live video state), Round (timed game segment), Wallet/Coins (in-app currency).
- **Modes:** OFFLINE, SOLO_PRIVATE, SOLO_PUBLIC, MATCH_PENDING, CO_STREAM_PUBLIC, CO_STREAM_PRIVATE, ROUND_ACTIVE, ROUND_COMPLETE.
- **Monetization:** In-app coins for gifts, super messages, and game requests. Creators earn from these, with a platform commission.
- **Live Streaming:** Solo (public/private) and Co-Stream capabilities.
- **Game Mechanics:** Shared engine for all games with pre-game, active round, and round complete phases. Games include "If This Is the Answer…", "Role Roulette", "What Would You Do If…", "2 sentences at a Time Story", "Complete the Headline", "Caption That Pic!", "Mystery Object", "Two Truths and a Lie", "This or That?", "Dream Job Switch", "Dance-Off", "Show Your Talent".
- **Safety & Moderation:** Community Guidelines, KYC verification for payouts, recording of sessions (public always, private with short retention), report/block tools, profanity filters.

### System Design Choices
- **In-Memory State:** Rooms and participants are stored in `Map` structures for low latency, with the trade-off of no persistence across server restarts.
- **Direct Message Relay:** The server acts as a simple relay for WebRTC signaling.
- **Health Endpoints:** Separate `/health` and `/_version` endpoints for monitoring.
- **Database:** PostgreSQL via Neon serverless driver, managed by Drizzle ORM. User data and session data are persisted, while WebRTC state is ephemeral.

## External Dependencies

### Third-Party Services
- **STUN/TURN Servers:** 
  - STUN: Google's public STUN server (`stun:stun.l.google.com:19302`) for NAT traversal
  - TURN: `turn:openrelay.metered.ca:80` (TCP) and `turns:openrelay.metered.ca:443` (TLS) with credentials for mobile network fallback

### Key NPM Packages
- **WebRTC:** Native browser WebRTC APIs (no external libraries).
- **WebSocket:** `ws` library for server-side WebSocket handling.
- **UI Framework:** `@radix-ui/*`, `class-variance-authority`, `tailwindcss`.
- **Database:** `@neondatabase/serverless`, `drizzle-orm`, `drizzle-kit`.
- **Development:** `@replit/*` plugins, `vite`.

### API Integration Points
- **WebSocket Signaling:** `wss://[host]/ws` endpoint.
- **REST Endpoints:** For health checks and potential future user management.
- **Authentication:** Schema for user/password exists, but the full authentication flow is not yet implemented.