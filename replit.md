# Social Streamy

## Overview
Social Streamy is a WebRTC-based live streaming platform for real-time video broadcasting. It enables hosts to broadcast to viewers using peer-to-peer WebRTC connections for video and WebSockets for signaling. The platform features a dark-first UI inspired by modern streaming services. The business vision is to create a social, interactive entertainment platform focused on short 1-to-1 live game sessions and optional public co-streams, with monetization through in-app purchases like gifts, super messages, and tips.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The application utilizes a "video-first" design with a dark-first color scheme (deep charcoal with vibrant purple accents), minimal cognitive load, and responsive layout prioritizing video content. It uses Inter font for UI and JetBrains Mono for technical data.

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
Supports Host (broadcaster), Guest (co-host with bidirectional media), and Viewer (receive-only) roles. The server maintains in-memory room state and relays signaling messages. Features include TURN server configuration for NAT traversal, WebSocket heartbeats for mobile reliability, and extended signaling for co-host management (requests, approvals, media exchange, fan-out to viewers).

**Co-host Management:**
Manual approval workflow for co-host requests, with Host UI for queue management and guest controls (mute, camera, end session).

**Game Mechanics:**
Host-authoritative game state synchronization with server-side tracking, version-based state sync, and rate-limited game message handlers. Client-side Game Panel UI for selection and interaction.

**Validation Runner:**
An automated testing suite for WebRTC and signaling flows, including scenarios for track readiness, signaling, video reception, guest upgrade, fan-out, WebSocket reconnects, ICE restart, TURN usage, and game state synchronization. Features fault injection controls, telemetry assertions, and downloadable JSON reports.

**End-User Pages:**
Minimal, mobile-first UI for public-facing host (`/host/:id`) and viewer (`/viewer/:id`) experiences. Pages include video display, co-host controls, game panels, and robust reconnection logic with toast notifications. Debug information is hidden from end-users.

**Signaling Server Optimization:**
Production-ready signaling infrastructure with message deduplication, payload validation, field sanitization, and token bucket rate limiting for ICE candidates and game events. Includes graceful shutdown, CORS allowlist, security headers, and WebSocket origin validation. Critical handlers are migrated to a MessageRouter with schema validation, with rollback capabilities. Features message coalescing, backpressure monitoring, session management with tokens, room lifecycle management, and Prometheus-compatible observability.

**Adaptive Streaming Quality:**
Production-ready quality system with platform-optimized video capture (720p@30fps, voice-optimized audio), codec selection (H.264 for iOS/Safari, VP9 preferred elsewhere), and three-tier bitrate ladder (High: 2.5Mbps, Medium: 1.2Mbps, Low: 600kbps). Features health-driven adaptive quality managers that poll getStats() every 2 seconds to calculate connection health from packet loss, RTT, and bitrate, automatically switching quality profiles to maintain smooth streaming. Per-viewer quality isolation ensures weak connections don't penalize others in mesh fan-out. Quality settings (codec preferences, bitrate profiles, degradation preferences, content hints) persist across renegotiations. OPUS audio optimized at 64-96kbps with high priority. Validation suite includes Q1-Q5 tests for quality metrics baseline, adaptive throttling, recovery, codec selection, and resolution constraints.

### Feature Specifications
- **Core Objects & Roles:** User, Creator, Session, Round, Wallet/Coins.
- **Modes:** OFFLINE, SOLO_PRIVATE, SOLO_PUBLIC, MATCH_PENDING, CO_STREAM_PUBLIC, CO_STREAM_PRIVATE, ROUND_ACTIVE, ROUND_COMPLETE.
- **Monetization:** In-app coins for gifts, super messages, and game requests, with platform commission.
- **Live Streaming:** Solo (public/private) and Co-Stream capabilities.
- **Game Mechanics:** Shared engine for various interactive games.
- **Safety & Moderation:** Community Guidelines, KYC, session recording, report/block tools, profanity filters.

### System Design Choices
- **In-Memory State:** Rooms and participants stored in `Map` for low latency (ephemeral state).
- **Direct Message Relay:** Server acts as a simple relay for WebRTC signaling.
- **Health Endpoints:** `/health` and `/_version` for monitoring.
- **Database:** PostgreSQL via Neon serverless driver, managed by Drizzle ORM for persistent user and session data.

## External Dependencies

### Third-Party Services
- **STUN/TURN Servers:** Google's public STUN server (`stun:stun.l.google.com:19302`) and `openrelay.metered.ca` for TURN (`turn:openrelay.metered.ca:80`, `turns:openrelay.metered.ca:443`).

### Key NPM Packages
- **WebRTC:** Native browser WebRTC APIs.
- **WebSocket:** `ws` library.
- **UI Framework:** `@radix-ui/*`, `class-variance-authority`, `tailwindcss`.
- **Database:** `@neondatabase/serverless`, `drizzle-orm`, `drizzle-kit`.
- **Development:** `@replit/*` plugins, `vite`.

### API Integration Points
- **WebSocket Signaling:** `wss://[host]/ws`.
- **REST Endpoints:** For health checks.