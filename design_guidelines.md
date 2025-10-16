# Social Streamy Design Guidelines

## Design Approach
**Reference-Based Approach** drawing from modern streaming platforms (Twitch, YouTube Live, Discord) with emphasis on video-first UI and minimal chrome. The interface prioritizes content clarity and functional efficiency while maintaining a polished, professional aesthetic.

## Core Design Principles
1. **Video-First Architecture**: All UI elements defer to video content - controls fade when inactive, overlays are translucent
2. **State Transparency**: Connection states, stream quality, and peer status are always visible but unobtrusive
3. **Minimal Cognitive Load**: Single-purpose controls, clear hierarchy, predictable interactions
4. **Dark-First Design**: Optimized for prolonged viewing sessions with reduced eye strain

---

## Color Palette

### Dark Mode (Primary)
- **Background Base**: 18 8% 12% (deep charcoal, almost black)
- **Surface Elevated**: 18 8% 16% (slightly lighter panels)
- **Surface Interactive**: 18 8% 22% (hover states, active cards)
- **Border Subtle**: 18 8% 28% (dividers, card edges)

### Accent Colors
- **Primary Brand**: 260 80% 58% (vibrant purple - streaming/live indicator)
- **Success/Live**: 142 76% 45% (green for active streams, connection success)
- **Warning**: 38 92% 50% (amber for degraded quality, ICE gathering)
- **Error/Disconnect**: 0 72% 51% (red for failed connections)

### Text Hierarchy
- **Primary Text**: 0 0% 98% (near-white for high contrast)
- **Secondary Text**: 0 0% 65% (muted for labels, metadata)
- **Tertiary Text**: 0 0% 45% (timestamps, subtle hints)

---

## Typography

### Font Stack
- **Primary**: Inter (via Google Fonts CDN) - exceptional readability at small sizes for stream metadata
- **Monospace**: JetBrains Mono - for technical data (userId, streamId, connection stats)

### Type Scale
- **Display/Hero**: text-4xl font-bold (stream titles)
- **Heading**: text-xl font-semibold (section headers)
- **Body**: text-base font-normal (standard UI text)
- **Caption**: text-sm font-medium (labels, metadata)
- **Technical**: text-xs font-mono (debug info, IDs)

---

## Layout System

### Spacing Primitives
Use Tailwind units of **2, 4, 8, 12, 16** for consistent rhythm:
- `p-2, m-2`: Tight spacing (button padding, icon gaps)
- `p-4, m-4`: Standard spacing (card padding, form fields)
- `p-8, m-8`: Section spacing (between major UI blocks)
- `p-12, p-16`: Large breathing room (page margins on desktop)

### Grid Strategy
- **Video Container**: Full-width with max-w-7xl constraint, aspect-ratio-video (16/9)
- **Controls Overlay**: Absolute positioned, bottom-0 with gradient fade backdrop
- **Sidebar (Future)**: 320px fixed width on desktop, full-width drawer on mobile
- **Test Harness**: max-w-5xl centered with grid-cols-2 for dual video feeds

---

## Component Library

### Video Player
- **Container**: Rounded corners (rounded-lg), subtle shadow (shadow-2xl)
- **Overlay Controls**: Translucent black backdrop (bg-black/40 backdrop-blur-sm)
- **State Indicators**: Floating badges (top-right) with pulsing animation for "LIVE"
- **Loading State**: Skeleton with animated pulse, background shimmer

### Buttons
- **Primary Action** (Go Live, Join Stream): bg-purple (260 80% 58%), rounded-lg, px-6 py-3, font-semibold
- **Secondary**: Outline style with border-2, hover lifts with shadow-md transition
- **Icon Buttons**: Square (p-2), rounded-md, hover bg-white/10

### Connection Status Cards
- **Layout**: Flex row with icon (left), text content (center), status dot (right)
- **States**: 
  - Connected: Green dot (142 76% 45%) with pulse animation
  - Connecting: Amber dot with rotate animation  
  - Disconnected: Red dot, static
- **Typography**: Primary text (userId/role), secondary text (connection state)

### Stream Metadata Panel
- **Background**: Surface elevated (18 8% 16%)
- **Border**: 1px solid border-subtle
- **Padding**: p-4
- **Layout**: Grid with key-value pairs, monospace for technical IDs
- **Visibility**: Collapsible accordion, hidden by default, toggled with keyboard shortcut

### Form Inputs
- **Text Fields**: bg-surface-interactive, border border-subtle, rounded-md, px-3 py-2
- **Focus State**: ring-2 ring-purple/50, border-purple
- **Select Dropdowns**: Custom styled with chevron icon, same styling as text fields
- **Labels**: text-sm text-secondary above inputs, mb-1

---

## Test Harness Specific

### Role Selector
- Segmented control design (host/viewer/guest toggle)
- Active role: bg-purple text-white
- Inactive: bg-surface-interactive text-secondary, hover bg-surface-elevated

### Video Grid
- **Desktop**: grid-cols-2 gap-4 (local left, remote right)
- **Mobile**: grid-cols-1 gap-3 (stacked, remote on top)
- **Labels**: Positioned absolute top-2 left-2 with bg-black/60 backdrop-blur px-2 py-1 rounded

### Debug Console
- Bottom drawer, max-height 240px, overflow-y-auto
- Each log entry: flex row with emoji icon, timestamp (text-xs text-tertiary), message
- Background: bg-black/80, monospace font
- Toggle visibility with keyboard shortcut (Ctrl+`)

### Connection Controls
- Horizontal flex layout: flex gap-2 flex-wrap
- Buttons: Secondary style, disabled state with opacity-50 cursor-not-allowed
- Icons: Use Heroicons (outline style) via CDN - VideoCameraIcon, WifiIcon, UserIcon

---

## Animations

Use **sparingly** - only for meaningful state changes:

1. **LIVE Indicator**: Pulse animation (scale 1 → 1.05, opacity 0.8 → 1, duration 2s infinite)
2. **Connection Status Dot**: 
   - Connecting: Rotate spinner (360deg, duration 1s linear infinite)
   - Connected: Single pulse on transition (scale 0 → 1, opacity 0 → 1)
3. **Video Load**: Fade-in (opacity 0 → 1, duration 300ms ease-out)
4. **Button Hover**: Subtle lift (translateY -1px, shadow-md, duration 150ms)

**No**: Parallax, scroll-triggered animations, elaborate transitions

---

## Accessibility & Polish

- All interactive elements have focus-visible ring with 2px offset
- Video controls have aria-labels ("Mute microphone", "Stop camera")
- Status messages use aria-live regions for screen reader announcements
- Minimum touch target: 44px × 44px (iOS guideline)
- Color contrast ratio: 4.5:1 minimum for text, 3:1 for large UI elements

---

## Images

**Test Harness**: No images - purely functional UI with video feeds

**Future Streaming UI**: 
- **Stream Thumbnails**: 16:9 aspect ratio cards with rounded-lg, overflow-hidden
- **User Avatars**: Circular (rounded-full), 40px × 40px default size
- **Placeholder States**: Use gradient backgrounds (purple to blue diagonal) when no video available

No hero images - this is a utility application where the video stream IS the hero content.