# Social Streamy

## Overview

Social Streamy is a WebRTC-based live streaming platform that enables real-time video broadcasting from hosts to viewers. The application uses peer-to-peer WebRTC connections for video transmission with WebSocket signaling for connection negotiation. Built with a React frontend and Express backend, it features a dark-first UI optimized for prolonged viewing sessions.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Technology Stack:**
- **Framework:** React 18 with TypeScript
- **Routing:** Wouter (lightweight alternative to React Router)
- **UI Components:** Radix UI primitives with shadcn/ui design system
- **Styling:** Tailwind CSS with custom design tokens
- **State Management:** TanStack Query (React Query) for server state
- **Build Tool:** Vite with custom plugins for Replit integration

**Design System:**
The application follows a "video-first" design philosophy inspired by modern streaming platforms (Twitch, YouTube Live, Discord). Key design principles include:
- Dark-first color scheme (deep charcoal backgrounds with vibrant purple accents)
- Minimal cognitive load with single-purpose controls
- Typography using Inter for UI and JetBrains Mono for technical data
- Responsive layout system prioritizing video content

**Component Architecture:**
- Page-based routing structure (`/` for home, `/harness` for WebRTC test interface)
- Reusable UI components from shadcn/ui with customized variants
- WebRTC logic encapsulated in TestHarness component with role-based rendering (host/viewer)

### Backend Architecture

**Technology Stack:**
- **Runtime:** Node.js with TypeScript
- **Framework:** Express.js
- **WebSocket:** ws library for real-time signaling
- **Database ORM:** Drizzle ORM configured for PostgreSQL
- **Session Management:** connect-pg-simple (PostgreSQL session store)

**Server Structure:**
- **Route Registration:** Centralized in `server/routes.ts`
- **WebSocket Signaling:** Dedicated `/ws` endpoint for WebRTC negotiation
- **Health Endpoints:** `/health` and `/_version` for monitoring
- **Development Mode:** Vite middleware integration for HMR

**WebRTC Signaling Flow:**
1. Participants connect to WebSocket endpoint
2. Host/viewer roles established via `join_as_host`/`join_as_viewer` messages
3. Server maintains in-memory room state mapping streamId → participants
4. Signaling messages (`webrtc_offer`, `webrtc_answer`, `ice_candidate`) relayed by userId
5. Participant count updates broadcast to all room members

**Key Architectural Decisions:**
- **In-Memory State:** Rooms and participants stored in Map structures for low latency; trade-off is no persistence across server restarts
- **Direct Message Relay:** Server acts as simple relay for WebRTC signaling without session management complexity
- **Separate Health Endpoints:** `/health` for load balancers, `/_version` for deployment verification

### Data Storage

**Database:**
- **Primary Database:** PostgreSQL via Neon serverless driver
- **ORM:** Drizzle ORM with type-safe schema definitions
- **Schema Location:** `shared/schema.ts` for isomorphic access

**Current Schema:**
```typescript
users table:
  - id: UUID primary key (auto-generated)
  - username: text unique
  - password: text (hashed)
```

**Storage Strategy:**
- **User Data:** Persisted in PostgreSQL
- **Session Data:** PostgreSQL-backed sessions via connect-pg-simple
- **WebRTC State:** Ephemeral in-memory storage (not persisted)

**Migration Strategy:**
- Drizzle Kit for schema migrations
- Migration files in `/migrations` directory
- Push command: `npm run db:push`

### External Dependencies

**Third-Party Services:**
- **STUN Server:** Google's public STUN server (`stun:stun.l.google.com:19302`) for NAT traversal
- **TURN Server:** Planned but not implemented (TODO comment indicates future TCP/TLS TURN server)

**Key NPM Packages:**
- **WebRTC:** Native browser WebRTC APIs (no external libraries)
- **WebSocket:** `ws` library for server-side WebSocket handling
- **UI Framework:** 
  - `@radix-ui/*` primitives (20+ component packages)
  - `class-variance-authority` for component variants
  - `tailwindcss` for styling
- **Database:**
  - `@neondatabase/serverless` for PostgreSQL connection
  - `drizzle-orm` and `drizzle-kit` for ORM and migrations
- **Development:**
  - `@replit/*` plugins for Replit-specific features
  - `vite` with React plugin for build/dev

**API Integration Points:**
- WebSocket signaling endpoint: `wss://[host]/ws` (protocol-aware URL construction)
- REST endpoints for health checks and potential future user management
- No external API integrations currently implemented

**Authentication:**
Schema includes user/password table but authentication flow not yet implemented in routes.