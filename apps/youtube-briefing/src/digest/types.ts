/**
 * Grounded Digest Types
 *
 * The LLM never invents a timestamp, title, channel, or evidence ID.
 * Application code owns video metadata and derives the "Watch key
 * moment" URL from validated transcript evidence.
 */

import type { IdentifiedSegment } from '../transcript/segments.js';

export interface ProfileForDigest {
  id: string;
  name: string;
  interests: string[];
  projects: string[];
  strategyThemes: string[];
}

export interface DigestVideoInput {
  videoId: string;
  title: string;
  channelName: string | null;
  durationSeconds: number;
  combinedScore: number;
  segments: IdentifiedSegment[];
}

export interface EvidenceProvenance {
  evidenceId: string;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
  sourceSegmentIds: string[];
}

/**
 * One grounded subtopic/point extracted from a video, always backed by a
 * validated transcript span - the model may never invent `text` without
 * an accompanying resolvable reference; application code derives
 * `timestampUrl` and `evidence` from that reference, never from the model.
 */
export interface GroundedDigestPoint {
  text: string;
  timestampUrl: string;
  evidence: EvidenceProvenance;
}

/**
 * One video's summary: an ungrounded (but non-fabricating) precis for
 * fast orientation, plus an ordered list of grounded points. A summary
 * with zero points is never constructed - see validation.ts/generator.ts -
 * an ungrounded precis alone would violate the whole system's grounding
 * guarantee.
 */
export interface GroundedVideoSummary {
  videoId: string;
  videoTitle: string;
  channelName: string;
  precis: string;
  points: GroundedDigestPoint[];
}

export interface GroundedDigest {
  id: string;
  profileId: string;
  generatedAt: string;
  videos: GroundedVideoSummary[];
  minutesSaved: number;
  videoCount: number;
  totalDuration: number;
}

export type DigestBuildResult =
  | { status: 'ready'; digest: GroundedDigest; selectedVideoIds: string[] }
  | { status: 'empty' }
  | { status: 'deferred'; reason: string }
  | { status: 'invalid'; reason: string };
