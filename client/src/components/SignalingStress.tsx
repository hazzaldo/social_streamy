import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { SignalingClient } from '@/lib/signaling';

interface TestResult {
  name: string;
  status: 'pending' | 'running' | 'pass' | 'fail';
  duration?: number;
  message?: string;
}

interface MetricsData {
  timestamp: string;
  connected_sockets: number;
  rooms_total: number;
  msgs_in_total?: number;
  msgs_out_total?: number;
  msgs_duplicates?: number;
  rate_limited_ice_candidate?: number;
  rate_limited_game_event?: number;
}

export function SignalingStress() {
  const [tests, setTests] = useState<TestResult[]>([
    { name: 'Duplicate Message Test', status: 'pending' },
    { name: 'ICE Flood Test', status: 'pending' },
    { name: 'Game Spam Test', status: 'pending' },
    { name: 'Resume Test', status: 'pending' },
    { name: 'Coalescing Check', status: 'pending' }
  ]);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const { toast } = useToast();

  // Fetch metrics every 2 seconds
  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await fetch('/metrics');
        const text = await response.text();
        
        // Parse Prometheus format
        const parsed: any = { timestamp: new Date().toISOString() };
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('#') || !line.trim()) continue;
          const parts = line.split(' ');
          if (parts.length === 2) {
            const [key, value] = parts;
            parsed[key] = parseFloat(value) || 0;
          }
        }
        setMetrics(parsed);
      } catch (error) {
        console.error('Failed to fetch metrics:', error);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 2000);
    return () => clearInterval(interval);
  }, []);

  const updateTest = (name: string, updates: Partial<TestResult>) => {
    setTests(prev => prev.map(t => t.name === name ? { ...t, ...updates } : t));
  };

  const runDuplicateTest = async (): Promise<void> => {
    const testName = 'Duplicate Message Test';
    updateTest(testName, { status: 'running' });
    const start = Date.now();

    try {
      const ws = new WebSocket(`wss://${window.location.host}/ws`);
      
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      // Join stream first
      ws.send(JSON.stringify({
        type: 'join_stream',
        streamId: 'stress-test',
        userId: `stress-${Date.now()}`
      }));

      await new Promise(resolve => setTimeout(resolve, 100));

      // Send same message with same msgId 5 times
      const msgId = `dup_${Date.now()}`;
      const message = {
        type: 'echo',
        msgId,
        payload: 'duplicate test'
      };

      let ackCount = 0;
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ack' && msg.for === msgId) {
          ackCount++;
        }
      };

      // Send 5 times
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify(message));
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Wait for acks
      await new Promise(resolve => setTimeout(resolve, 1000));

      ws.close();

      const duration = Date.now() - start;
      
      if (ackCount === 1) {
        updateTest(testName, { 
          status: 'pass', 
          duration,
          message: `Received 1 ack (4 duplicates ignored) ✓`
        });
      } else {
        updateTest(testName, { 
          status: 'fail',
          duration,
          message: `Expected 1 ack, got ${ackCount}`
        });
      }
    } catch (error: any) {
      updateTest(testName, { 
        status: 'fail', 
        duration: Date.now() - start,
        message: error.message
      });
    }
  };

  const runICEFloodTest = async (): Promise<void> => {
    const testName = 'ICE Flood Test';
    updateTest(testName, { status: 'running' });
    const start = Date.now();

    try {
      const ws = new WebSocket(`wss://${window.location.host}/ws`);
      
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const userId = `stress-${Date.now()}`;
      
      // Join stream first
      ws.send(JSON.stringify({
        type: 'join_stream',
        streamId: 'stress-test',
        userId
      }));

      await new Promise(resolve => setTimeout(resolve, 100));

      let rateLimitErrors = 0;
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'error' && msg.code === 'rate_limited') {
          rateLimitErrors++;
        }
      };

      // Send 500 ICE candidates rapidly
      for (let i = 0; i < 500; i++) {
        ws.send(JSON.stringify({
          type: 'ice_candidate',
          fromUserId: userId,
          toUserId: 'host',
          candidate: {
            candidate: `candidate:${i} 1 udp 2122260223 192.168.1.${i % 255} ${1024 + i} typ host`,
            sdpMid: '0',
            sdpMLineIndex: 0
          }
        }));
        
        if (i % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      // Wait for rate limit errors
      await new Promise(resolve => setTimeout(resolve, 2000));

      ws.close();

      const duration = Date.now() - start;
      
      if (rateLimitErrors > 0) {
        updateTest(testName, { 
          status: 'pass', 
          duration,
          message: `${rateLimitErrors} rate limit errors, connection stable ✓`
        });
      } else {
        updateTest(testName, { 
          status: 'fail',
          duration,
          message: 'No rate limiting detected'
        });
      }
    } catch (error: any) {
      updateTest(testName, { 
        status: 'fail', 
        duration: Date.now() - start,
        message: error.message
      });
    }
  };

  const runGameSpamTest = async (): Promise<void> => {
    const testName = 'Game Spam Test';
    updateTest(testName, { status: 'running' });
    const start = Date.now();

    try {
      const ws = new WebSocket(`wss://${window.location.host}/ws`);
      
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const userId = `stress-${Date.now()}`;
      
      // Join stream
      ws.send(JSON.stringify({
        type: 'join_stream',
        streamId: 'stress-test',
        userId
      }));

      await new Promise(resolve => setTimeout(resolve, 100));

      let rateLimitErrors = 0;
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'game_error' && msg.code === 'rate_limited') {
          rateLimitErrors++;
        }
      };

      // Send 20 game events in 3 seconds (should trigger rate limiting)
      for (let i = 0; i < 20; i++) {
        ws.send(JSON.stringify({
          type: 'game_event',
          streamId: 'stress-test',
          eventType: 'submit_caption',
          payload: { text: `caption ${i}` },
          from: userId
        }));
        await new Promise(resolve => setTimeout(resolve, 150)); // 150ms between events
      }

      // Wait for responses
      await new Promise(resolve => setTimeout(resolve, 1000));

      ws.close();

      const duration = Date.now() - start;
      
      if (rateLimitErrors > 0) {
        updateTest(testName, { 
          status: 'pass', 
          duration,
          message: `${rateLimitErrors} throttled, rate limiting active ✓`
        });
      } else {
        updateTest(testName, { 
          status: 'fail',
          duration,
          message: 'No rate limiting detected'
        });
      }
    } catch (error: any) {
      updateTest(testName, { 
        status: 'fail', 
        duration: Date.now() - start,
        message: error.message
      });
    }
  };

  const runResumeTest = async (): Promise<void> => {
    const testName = 'Resume Test';
    updateTest(testName, { status: 'running' });
    const start = Date.now();

    try {
      // First connection - get session token
      let sessionToken: string | null = null;
      let ws = new WebSocket(`wss://${window.location.host}/ws`);
      
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'join_confirmed' && msg.sessionToken) {
          sessionToken = msg.sessionToken;
        }
      };

      // Join stream
      ws.send(JSON.stringify({
        type: 'join_stream',
        streamId: 'stress-test',
        userId: `stress-${Date.now()}`
      }));

      // Wait for session token
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!sessionToken) {
        throw new Error('No session token received');
      }

      // Close connection
      ws.close();
      await new Promise(resolve => setTimeout(resolve, 500));

      // Reconnect with resume
      ws = new WebSocket(`wss://${window.location.host}/ws`);
      
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      let resumeOk = false;
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'resume_ok') {
          resumeOk = true;
        }
      };

      // Send resume
      ws.send(JSON.stringify({
        type: 'resume',
        sessionToken,
        roomId: 'stress-test'
      }));

      // Wait for resume confirmation
      await new Promise(resolve => setTimeout(resolve, 1000));

      ws.close();

      const duration = Date.now() - start;
      
      if (resumeOk) {
        updateTest(testName, { 
          status: 'pass', 
          duration,
          message: 'Session resumed successfully ✓'
        });
      } else {
        updateTest(testName, { 
          status: 'fail',
          duration,
          message: 'Resume failed'
        });
      }
    } catch (error: any) {
      updateTest(testName, { 
        status: 'fail', 
        duration: Date.now() - start,
        message: error.message
      });
    }
  };

  const runCoalescingTest = async (): Promise<void> => {
    const testName = 'Coalescing Check';
    updateTest(testName, { status: 'running' });
    const start = Date.now();

    try {
      const ws = new WebSocket(`wss://${window.location.host}/ws`);
      
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const userId = `stress-${Date.now()}`;
      
      // Join as host
      ws.send(JSON.stringify({
        type: 'join_stream',
        streamId: 'stress-test',
        userId
      }));

      await new Promise(resolve => setTimeout(resolve, 100));

      let stateUpdateCount = 0;
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'game_state') {
          stateUpdateCount++;
        }
      };

      // Send 100 rapid game state updates
      for (let i = 0; i < 100; i++) {
        ws.send(JSON.stringify({
          type: 'game_state',
          streamId: 'stress-test',
          version: i + 1,
          patch: { counter: i }
        }));
        await new Promise(resolve => setTimeout(resolve, 5)); // 5ms between updates
      }

      // Wait for coalesced updates
      await new Promise(resolve => setTimeout(resolve, 2000));

      ws.close();

      const duration = Date.now() - start;
      
      // With 33ms coalescing, we expect roughly 30-40 updates/sec instead of 200/sec
      if (stateUpdateCount < 50) {
        updateTest(testName, { 
          status: 'pass', 
          duration,
          message: `${stateUpdateCount} updates (coalesced from 100) ✓`
        });
      } else {
        updateTest(testName, { 
          status: 'fail',
          duration,
          message: `${stateUpdateCount} updates (expected < 50)`
        });
      }
    } catch (error: any) {
      updateTest(testName, { 
        status: 'fail', 
        duration: Date.now() - start,
        message: error.message
      });
    }
  };

  const runAllTests = async () => {
    setIsRunning(true);
    
    // Reset all tests
    setTests(prev => prev.map(t => ({ ...t, status: 'pending' as const, duration: undefined, message: undefined })));

    try {
      await runDuplicateTest();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await runICEFloodTest();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await runGameSpamTest();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await runResumeTest();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await runCoalescingTest();

      const allPassed = tests.every(t => t.status === 'pass');
      toast({
        title: allPassed ? 'All Tests Passed! ✓' : 'Some Tests Failed',
        description: `Completed ${tests.length} stress tests`,
        variant: allPassed ? 'default' : 'destructive'
      });
    } finally {
      setIsRunning(false);
    }
  };

  const getStatusBadge = (status: TestResult['status']) => {
    const variants: Record<string, any> = {
      pending: 'secondary',
      running: 'default',
      pass: 'default',
      fail: 'destructive'
    };
    
    const colors: Record<string, string> = {
      pending: 'text-muted-foreground',
      running: 'text-blue-500',
      pass: 'text-green-500',
      fail: 'text-red-500'
    };

    return (
      <Badge variant={variants[status]} className={colors[status]}>
        {status.toUpperCase()}
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Signaling Stress Tests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button 
              onClick={runAllTests} 
              disabled={isRunning}
              data-testid="button-run-all-stress-tests"
            >
              {isRunning ? 'Running...' : 'Run All Tests'}
            </Button>
          </div>

          <div className="space-y-2">
            {tests.map((test) => (
              <div key={test.name} className="flex items-center justify-between p-3 rounded-md bg-card border">
                <div className="flex-1">
                  <div className="font-medium">{test.name}</div>
                  {test.message && (
                    <div className="text-sm text-muted-foreground">{test.message}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {test.duration && (
                    <span className="text-sm text-muted-foreground">{test.duration}ms</span>
                  )}
                  {getStatusBadge(test.status)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Metrics Display */}
      {metrics && (
        <Card>
          <CardHeader>
            <CardTitle>Live Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">Rooms</div>
                <div className="text-2xl font-bold">{metrics.rooms_total}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Sockets</div>
                <div className="text-2xl font-bold">{metrics.connected_sockets}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Messages In</div>
                <div className="text-2xl font-bold">{metrics.msgs_in_total || 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Messages Out</div>
                <div className="text-2xl font-bold">{metrics.msgs_out_total || 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Duplicates</div>
                <div className="text-2xl font-bold">{metrics.msgs_duplicates || 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">ICE Rate Limited</div>
                <div className="text-2xl font-bold">{metrics.rate_limited_ice_candidate || 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Game Rate Limited</div>
                <div className="text-2xl font-bold">{metrics.rate_limited_game_event || 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
