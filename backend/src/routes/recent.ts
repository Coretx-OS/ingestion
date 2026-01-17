import express, { type Request, type Response } from 'express';
import { getDb } from '../db/connection.js';
import type { RecentResponse, RecentItem } from '../domain/types.js';

export const recentRouter = express.Router();

interface RecentRow {
  capture_id: string;
  inbox_log_id: string;
  captured_at: string;
  raw_text: string;
  status: 'filed' | 'needs_review' | 'fixed';
  filed_type: string | null;
  filed_title: string | null;
  confidence: number | null;
  record_id: string | null;
  log_id: number;
}

/**
 * GET /recent
 * Get recent captures with pagination
 *
 * Query params:
 * - limit: Number of items to return (default 20, max 100)
 * - cursor: log_id to start from (for pagination)
 *
 * Returns:
 * - items: Array of recent items (latest inbox_log per capture_id)
 * - next_cursor: log_id of last item (null if no more)
 */
recentRouter.get('/', async (req: Request, res: Response) => {
  try {
    // Parse query params
    const limitParam = parseInt(req.query.limit as string, 10);
    const limit = Math.min(Math.max(limitParam || 20, 1), 100);
    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : null;

    const db = getDb();

    // Query: Get latest inbox_log per capture_id, ordered by log_id DESC
    // Uses subquery to find the MAX(log_id) per capture_id (latest event)
    const query = `
      SELECT
        c.capture_id,
        il.inbox_log_id,
        c.captured_at,
        c.raw_text,
        il.status,
        il.filed_type,
        il.filed_title,
        il.confidence,
        il.record_id,
        il.log_id
      FROM captures c
      INNER JOIN inbox_log il ON il.capture_id = c.capture_id
      INNER JOIN (
        SELECT capture_id, MAX(log_id) as max_log_id
        FROM inbox_log
        GROUP BY capture_id
      ) latest ON il.capture_id = latest.capture_id AND il.log_id = latest.max_log_id
      WHERE (? IS NULL OR il.log_id < ?)
      ORDER BY il.log_id DESC
      LIMIT ?
    `;

    const rows = db.prepare(query).all(cursor, cursor, limit) as RecentRow[];

    // Transform rows to RecentItem format
    const items: RecentItem[] = rows.map((row) => {
      // Defensive: Log if confidence is NULL (should never happen after fixes)
      if (row.confidence === null) {
        console.error(`CRITICAL: NULL confidence in inbox_log ${row.inbox_log_id}`);
      }

      return {
        capture_id: row.capture_id,
        inbox_log_id: row.inbox_log_id,
        captured_at: row.captured_at,
        raw_text_preview: row.raw_text.substring(0, 100), // First 100 chars
        status: row.status,
        type: (row.filed_type || 'admin') as 'person' | 'project' | 'idea' | 'admin',
        title: row.filed_title || 'Unfiled capture',
        confidence: row.confidence, // No default masking - expose NULL if it occurs
        record_id: row.record_id,
      };
    });

    // Determine next_cursor (log_id of last item, if we got full page)
    const lastLogId = rows.length === limit && rows.length > 0 ? rows[rows.length - 1].log_id.toString() : null;

    const response: RecentResponse = {
      items,
      next_cursor: lastLogId,
    };

    res.json(response);
  } catch (error) {
    console.error('Error in GET /recent:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
