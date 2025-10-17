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
Participants connect via WebSocket. Host/viewer roles are established, and the server maintains in-memory room state. Signaling messages (offer, answer, ICE candidates) are relayed by `userId`.

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
- **STUN Server:** Google's public STUN server (`stun:stun.l.google.com:19302`) is used for NAT traversal. TURN server integration is planned.

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