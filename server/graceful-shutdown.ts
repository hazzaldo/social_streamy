import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export class GracefulShutdown {
  private server: Server;
  private wss: WebSocketServer;
  private shutdownTimeout: number;
  private isShuttingDown = false;

  constructor(server: Server, wss: WebSocketServer, shutdownTimeout: number = 5000) {
    this.server = server;
    this.wss = wss;
    this.shutdownTimeout = shutdownTimeout;
  }

  // Setup signal handlers
  init() {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('uncaughtException', (error) => {
      console.error('[GracefulShutdown] Uncaught exception:', error);
      this.shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[GracefulShutdown] Unhandled rejection:', reason);
      this.shutdown('unhandledRejection');
    });
  }

  // Perform graceful shutdown
  private async shutdown(signal: string) {
    if (this.isShuttingDown) {
      console.log('[GracefulShutdown] Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    console.log(`[GracefulShutdown] Received ${signal}, starting graceful shutdown...`);

    // Stop accepting new connections
    this.wss.close(() => {
      console.log('[GracefulShutdown] WebSocket server stopped accepting new connections');
    });

    // Close all existing WebSocket connections gracefully
    const closePromises: Promise<void>[] = [];
    
    this.wss.clients.forEach((ws: WebSocket) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Send shutdown notification
        try {
          ws.send(JSON.stringify({
            type: 'server_shutdown',
            message: 'Server is shutting down'
          }));
        } catch (e) {
          console.error('[GracefulShutdown] Failed to send shutdown notification:', e);
        }

        // Close connection
        closePromises.push(
          new Promise((resolve) => {
            ws.once('close', () => resolve());
            ws.close(1001, 'Server shutdown');
          })
        );
      }
    });

    // Wait for all connections to close or timeout
    const drainPromise = Promise.all(closePromises);
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, this.shutdownTimeout));

    await Promise.race([drainPromise, timeoutPromise]);

    const remainingClients = this.wss.clients.size;
    if (remainingClients > 0) {
      console.log(`[GracefulShutdown] Timeout reached, ${remainingClients} connections still open, forcing close`);
      this.wss.clients.forEach((ws: WebSocket) => {
        ws.terminate();
      });
    } else {
      console.log('[GracefulShutdown] All WebSocket connections closed');
    }

    // Close HTTP server
    this.server.close(() => {
      console.log('[GracefulShutdown] HTTP server closed');
      process.exit(0);
    });

    // Force exit if server doesn't close within 1 second
    setTimeout(() => {
      console.error('[GracefulShutdown] Server did not close in time, forcing exit');
      process.exit(1);
    }, 1000);
  }
}
