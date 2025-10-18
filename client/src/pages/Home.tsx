import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioIcon, VideoIcon, WifiIcon, TestTube2Icon } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background to-background" />
        <div className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="mb-6 flex justify-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                <RadioIcon className="h-10 w-10 text-primary" />
              </div>
            </div>
            <h1 className="text-5xl font-bold tracking-tight sm:text-6xl" data-testid="text-app-title">
              Social Streamy
            </h1>
            <p className="mt-6 text-lg leading-8 text-muted-foreground max-w-2xl mx-auto" data-testid="text-app-description">
              WebRTC-based live streaming platform with real-time host → viewer broadcast,
              WebSocket signaling, and peer-to-peer video communication
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link href="/host/demo">
                <Button size="lg" variant="default" data-testid="button-start-host">
                  <VideoIcon className="mr-2 h-5 w-5" />
                  Start Hosting
                </Button>
              </Link>
              <Link href="/viewer/demo">
                <Button size="lg" variant="outline" data-testid="button-join-viewer">
                  <RadioIcon className="mr-2 h-5 w-5" />
                  Join as Viewer
                </Button>
              </Link>
              <Link href="/harness">
                <Button size="lg" variant="secondary" data-testid="button-open-harness">
                  <TestTube2Icon className="mr-2 h-5 w-5" />
                  Test Harness
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-3">
          <Card>
            <CardHeader>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                <VideoIcon className="h-6 w-6 text-primary" />
              </div>
              <CardTitle>WebRTC Streaming</CardTitle>
              <CardDescription>
                Host publishes camera/mic, viewers receive real-time video with low latency
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>• One-to-many broadcasting</li>
                <li>• STUN/TURN ICE servers</li>
                <li>• Automatic offer/answer flow</li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                <WifiIcon className="h-6 w-6 text-primary" />
              </div>
              <CardTitle>WebSocket Signaling</CardTitle>
              <CardDescription>
                Secure WSS signaling for SDP exchange and ICE candidate relay
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>• Room-based architecture</li>
                <li>• Message type validation</li>
                <li>• Connection state tracking</li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                <TestTube2Icon className="h-6 w-6 text-primary" />
              </div>
              <CardTitle>Test Harness</CardTitle>
              <CardDescription>
                Comprehensive debugging interface with detailed logging and controls
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>• Role selection (host/viewer)</li>
                <li>• Live connection status</li>
                <li>• Debug console output</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Technical Specs */}
      <div className="border-t">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold mb-8">Phase 1: Host → Viewer MVP</h2>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Message Shapes</h3>
              <div className="rounded-lg bg-card p-4 font-mono text-sm space-y-2">
                <div><span className="text-muted-foreground">Server → Host:</span></div>
                <div className="text-xs">{'{ type: "joined_stream", streamId, userId }'}</div>
                <div className="mt-3"><span className="text-muted-foreground">Relay:</span></div>
                <div className="text-xs">{'webrtc_offer | webrtc_answer | ice_candidate'}</div>
              </div>
            </div>
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Definition of Done</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>✓ Host: 🎥 Local tracks ready</li>
                <li>✓ Host: 👤 Participant joined stream</li>
                <li>✓ Host: 📤 SENDING webrtc_offer</li>
                <li>✓ Viewer: 📥 RECEIVED webrtc_offer</li>
                <li>✓ Viewer: 📤 SENDING webrtc_answer</li>
                <li>✓ Viewer sees host video</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
