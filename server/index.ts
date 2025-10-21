import express, { type Request, Response, NextFunction } from 'express';
import { registerRoutes } from './routes';
import { setupVite, serveStatic, log } from './vite';
import { corsMiddleware, securityHeadersMiddleware } from './security';

const app = express();

// Phase 1: Security // Phase 1: Security middleware (global)
app.use(securityHeadersMiddleware);

// Only apply CORS to programmatic endpoints (not HTML routes)
app.use('/api', corsMiddleware);
// (omit /ws unless you have HTTP routes there)

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (path.startsWith('/api')) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + '…';
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    res.status(status).json({ message });
    throw err;
  });

  app.use((req, res, next) => {
    if (
      req.path.match(/\.(html|js|css|mjs)$/i) ||
      req.path === '/' ||
      req.path.startsWith('/host') ||
      req.path.startsWith('/viewer')
    ) {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // We run Vite separately (CLI) in dev, so no middleware here.
  if (app.get('env') !== 'development') {
    serveStatic(app); // only in production do we serve built assets
  }

  // near the bottom of server/index.ts
  const port = parseInt(process.env.PORT || '5050', 10);
  // bind without forcing host so Node can choose IPv4/IPv6 as available
  server.listen(port, () => {
    const buildTag = 'WAVE3-H264-MVP';
    const timestamp = new Date().toISOString();
    console.log(`[BUILD] ${timestamp} ${buildTag}`);
    log(`serving on http://localhost:${port}`);
  });
})();
