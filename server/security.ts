import { Request, Response, NextFunction } from 'express';

// Parse ALLOWED_ORIGINS env variable
function getAllowedOrigins(): string[] {
  const originsEnv = process.env.ALLOWED_ORIGINS;
  if (!originsEnv) {
    // Default to all origins in development
    if (process.env.NODE_ENV === 'development') {
      return ['*'];
    }
    return [];
  }
  
  // Parse comma-separated list
  return originsEnv.split(',').map(o => o.trim()).filter(Boolean);
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const allowedOrigins = getAllowedOrigins();
  const origin = req.headers.origin || '';

  // Check if origin is allowed
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // HSTS (only in production, reverse proxy should set this)
  // Keeping this commented as it should be set by the reverse proxy in production
  // if (process.env.NODE_ENV === 'production') {
  //   res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // }
  
  next();
}

// Validate WebSocket upgrade origin
export function validateWebSocketOrigin(origin: string | undefined): boolean {
  const allowedOrigins = getAllowedOrigins();
  
  if (!origin) {
    // Allow same-origin requests (no origin header)
    return true;
  }
  
  if (allowedOrigins.includes('*')) {
    return true;
  }
  
  return allowedOrigins.includes(origin);
}
