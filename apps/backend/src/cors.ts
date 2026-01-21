import cors from 'cors';
import { config } from './config.js';

/**
 * Environment-aware CORS configuration
 *
 * DEVELOPMENT (NODE_ENV=development):
 *   - Allows http://localhost:3000 (from ALLOWED_ORIGINS)
 *   - Auto-allows ALL chrome-extension://* origins (pattern matched)
 *
 * PRODUCTION (NODE_ENV=production):
 *   - Requires explicit allowlist from ALLOWED_ORIGINS environment variable
 *   - No wildcard or pattern matching
 *
 * CRITICAL: Production should only contain specific extension IDs from Chrome Web Store.
 */
export const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like curl, mobile apps, same-origin)
    if (!origin) {
      return callback(null, true);
    }

    // Check exact match against allowlist
    if (config.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // DEVELOPMENT ONLY: Allow any chrome-extension:// origin
    if (config.nodeEnv === 'development' && origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }

    // Reject all other origins
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // 24 hours
};

/**
 * Log CORS configuration at startup
 */
export function logCorsConfig(): void {
  console.log('✅ CORS configured:');
  console.log(`   Allowed origins: ${config.allowedOrigins.join(', ')}`);

  // Show additional rules in development
  if (config.nodeEnv === 'development') {
    console.log(`   Dev mode: chrome-extension://* (all extension origins allowed)`);
  }

  console.log(`   Methods: GET, POST, OPTIONS`);
}
