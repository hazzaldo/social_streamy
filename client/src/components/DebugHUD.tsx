import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { X } from 'lucide-react';

export interface DebugStats {
  iceConnectionState: string;
  connectionState: string;
  codec: string;
  ontrackFired: boolean;
  framesDecoded: number;
  bytesReceived: number;
  frameWidth: number;
  frameHeight: number;
}

interface DebugHUDProps {
  pc: RTCPeerConnection | null;
  onRequestKeyframe?: () => void;
  onClose?: () => void;
}

export function DebugHUD({ pc, onRequestKeyframe, onClose }: DebugHUDProps) {
  const [stats, setStats] = useState<DebugStats>({
    iceConnectionState: 'unknown',
    connectionState: 'unknown',
    codec: 'unknown',
    ontrackFired: false,
    framesDecoded: 0,
    bytesReceived: 0,
    frameWidth: 0,
    frameHeight: 0,
  });

  useEffect(() => {
    if (!pc) return;

    const interval = setInterval(async () => {
      try {
        const newStats: DebugStats = {
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState,
          codec: 'unknown',
          ontrackFired: pc.getReceivers().length > 0,
          framesDecoded: 0,
          bytesReceived: 0,
          frameWidth: 0,
          frameHeight: 0,
        };

        // Get codec from remote description
        const remoteDesc = pc.remoteDescription;
        if (remoteDesc && remoteDesc.sdp) {
          const codecMatch = remoteDesc.sdp.match(/a=rtpmap:\d+\s+(\w+)/);
          if (codecMatch) {
            newStats.codec = codecMatch[1];
          }
        }

        // Get stats from getStats()
        const statsReport = await pc.getStats();
        statsReport.forEach((stat: any) => {
          if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
            newStats.framesDecoded = stat.framesDecoded || 0;
            newStats.bytesReceived = stat.bytesReceived || 0;
            newStats.frameWidth = stat.frameWidth || 0;
            newStats.frameHeight = stat.frameHeight || 0;
          }
        });

        setStats(newStats);
      } catch (err) {
        console.error('Failed to fetch debug stats:', err);
      }
    }, 500); // Update every 500ms

    return () => clearInterval(interval);
  }, [pc]);

  return (
    <Card className="fixed top-4 right-4 z-50 p-4 bg-black/90 text-white border-purple-500 max-w-sm" data-testid="debug-hud">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-purple-400">🐛 Debug HUD</h3>
        {onClose && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            className="h-6 w-6"
            data-testid="button-close-debug-hud"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      
      <div className="space-y-2 font-mono text-xs">
        <div className="flex justify-between">
          <span className="text-gray-400">ICE:</span>
          <span className={stats.iceConnectionState === 'connected' ? 'text-green-400' : 'text-yellow-400'}>
            {stats.iceConnectionState}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-400">Connection:</span>
          <span className={stats.connectionState === 'connected' ? 'text-green-400' : 'text-yellow-400'}>
            {stats.connectionState}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-400">Codec:</span>
          <span className="text-green-400">{stats.codec}</span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-400">ontrack:</span>
          <span className={stats.ontrackFired ? 'text-green-400' : 'text-red-400'}>
            {stats.ontrackFired ? 'true' : 'false'}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-400">framesDecoded:</span>
          <span className={stats.framesDecoded > 0 ? 'text-green-400' : 'text-red-400'}>
            {stats.framesDecoded}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-400">bytesReceived:</span>
          <span className="text-gray-300">{(stats.bytesReceived / 1024).toFixed(1)}KB</span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-400">Resolution:</span>
          <span className="text-gray-300">
            {stats.frameWidth}x{stats.frameHeight}
          </span>
        </div>
      </div>
      
      {onRequestKeyframe && (
        <Button
          size="sm"
          variant="outline"
          onClick={onRequestKeyframe}
          className="w-full mt-3"
          data-testid="button-request-keyframe"
        >
          Request Keyframe
        </Button>
      )}
    </Card>
  );
}
