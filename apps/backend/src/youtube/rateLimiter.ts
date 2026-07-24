/**
 * In-memory sliding-window rate limiter.
 *
 * Process-local and resets on restart - an accepted MVP limitation for the
 * AI Video Summary feature (see YOUTUBE-AI-VIDEO-SUMMARY-PLAN.md), which has
 * no database of its own to back a persistent limiter with.
 */

export interface RateLimiter {
  isAllowed(key: string): boolean;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export function createRateLimiter({ windowMs, max }: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    isAllowed(key: string): boolean {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }

      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}
