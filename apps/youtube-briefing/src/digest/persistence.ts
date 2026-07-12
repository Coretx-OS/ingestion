/**
 * Digest Persistence
 *
 * Persists only a validated, non-empty digest. Deliberately does NOT
 * mutate `videos.status` - the orchestrator commits the union of every
 * targeted profile's selected video IDs to `processed` in one place,
 * once every profile in the run has reached a status-safe outcome. See
 * scheduler/dailyBrief.ts for the commit predicate.
 */

import { getDb } from '../db/connection.js';
import type { GroundedDigest } from './types.js';

export function persistDigest(digest: GroundedDigest): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO digests (id, profile_id, generated_at, digest_json, minutes_saved, video_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(digest.id, digest.profileId, digest.generatedAt, JSON.stringify(digest), digest.minutesSaved, digest.videoCount);
}

export function getRecentDigests(profileId: string, limit: number = 10): GroundedDigest[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT digest_json FROM digests
       WHERE profile_id = ?
       ORDER BY generated_at DESC
       LIMIT ?`
    )
    .all(profileId, limit) as Array<{ digest_json: string }>;

  return rows.map((row) => JSON.parse(row.digest_json) as GroundedDigest);
}
