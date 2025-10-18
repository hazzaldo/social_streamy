# Social Streamy

A production-ready WebRTC-based live streaming platform for real-time video broadcasting with adaptive quality, co-host features, and interactive game capabilities.

## Features

- **Live Video Streaming**: Host-to-viewer broadcasting using WebRTC peer-to-peer connections
- **Co-host Support**: Viewers can request to join as co-hosts with bidirectional media
- **Adaptive Streaming Quality**: Automatic quality adjustment based on connection health (H.264/VP9 codecs)
- **Interactive Games**: Real-time game mechanics synchronized across all viewers
- **iOS/Safari Support**: Guaranteed H.264 codec compatibility for all platforms
- **Connection Recovery**: Automatic ICE restart and reconnection with exponential backoff
- **Debug HUD**: Real-time WebRTC statistics and diagnostics

## Tech Stack

**Frontend:**
- React 18 with TypeScript
- Wouter (routing)
- Radix UI + shadcn/ui components
- Tailwind CSS
- TanStack Query (server state)
- Vite (build tool)

**Backend:**
- Node.js with TypeScript
- Express.js
- WebSocket (`ws` library) for signaling
- Drizzle ORM + PostgreSQL
- Session management with `connect-pg-simple`

## Prerequisites

- Node.js 18+ 
- npm or yarn
- PostgreSQL database (optional - in-memory storage available)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd social-streamy
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables (optional):
```bash
# Create .env file
SESSION_SECRET=your-secret-key-here
```

## Running the Application

### Development Mode

Start the development server (runs both frontend and backend):

```bash
npm run dev
```

The application will be available at:
- **App**: http://localhost:5000
- **Host page**: http://localhost:5000/host/demo
- **Viewer page**: http://localhost:5000/viewer/demo

### Production Build

Build the application:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

## Key Endpoints

### Application Routes
- `/host/:id` - Host streaming interface
- `/viewer/:id` - Viewer interface

### API Endpoints
- `GET /_version` - Build version and timestamp
- `GET /health` - Basic health check
- `GET /healthz` - Detailed health with room information
- `WS /ws` - WebSocket signaling server

## Quick Start Guide

### As a Host:

1. Navigate to `/host/demo`
2. Click "Go Live" to start broadcasting
3. Copy the invite link and share with viewers
4. Manage co-host requests from the approval queue

### As a Viewer:

1. Navigate to `/viewer/demo` (or use the host's invite link)
2. Click "Join Stream" to watch
3. Click "Request Co-host" to join as a co-host (requires host approval)
4. Debug HUD appears automatically showing connection stats

## Development

### Project Structure

```
.
├── client/              # Frontend React application
│   ├── src/
│   │   ├── components/  # UI components
│   │   ├── pages/       # Route pages (Host, Viewer)
│   │   └── lib/         # Utilities (WebRTC, quality management)
├── server/              # Backend Express application
│   ├── routes.ts        # HTTP routes and WebSocket handlers
│   ├── wave1-handlers.ts # Signaling message handlers
│   └── index.ts         # Server entry point
└── shared/              # Shared types and schemas
```

### WebRTC Architecture

- **Signaling**: WebSocket-based message relay (offers, answers, ICE candidates)
- **Streaming**: Host sends video to viewers via sendonly transceivers
- **Co-hosting**: Bidirectional peer connections when viewer is promoted to guest
- **Codec Selection**: H.264 forced for all viewers (iOS/Safari compatibility)
- **Quality Management**: Health-driven adaptive quality with per-viewer isolation

### Debug Mode

The Debug HUD is always visible when viewing a stream. It displays:
- ICE connection state
- Negotiated codec
- Frames decoded
- Bytes received
- Video resolution
- "Request Keyframe" button for recovery

Build tag `WAVE3-H264-MVP` is visible:
- Server console on startup
- `/_version` endpoint
- Purple badge at top-right of Host/Viewer pages
- `window.__BUILD_TAG__` in browser console

## Troubleshooting

### Black Screen on Viewer

Check the Debug HUD for:
- `ontrack: false` - NO_ONTRACK watchdog will log error after 5s
- `framesDecoded: 0` - NO_FRAMES watchdog will request keyframe after 3s
- `codec: unknown` - Codec negotiation failed

### Connection Issues

- Check browser console for `[HOST]` and `[VIEWER]` logs
- Verify ICE candidates are being exchanged
- Try clicking "Request Keyframe" in Debug HUD
- Check `/healthz` endpoint for room status

### Co-host Not Working

Console should show:
1. `[VIEWER] cohost_request sent`
2. `[SERVER] relayed cohost_request → host` (server logs)
3. `[HOST] cohost_request received` (host console)

If approval UI doesn't appear, check the co-host queue state.

## Environment Variables

- `PORT` - Server port (default: 5000)
- `SESSION_SECRET` - Session encryption key
- `NODE_ENV` - Environment mode (development/production)
- `TURN_URL` / `TURNS_URL` - TURN server URLs (optional)
- `TURN_USERNAME` / `TURN_CREDENTIAL` - TURN credentials (optional)

## License

See LICENSE file for details.
