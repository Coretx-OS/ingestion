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

export interface GroundedDigestBullet {
  videoId: string;
  videoTitle: string;
  channelName: string;
  bullet: string;
  whyItMatters: string;
  timestampUrl: string;
  tags: string[];
  evidence: EvidenceProvenance;
}

export interface GroundedDigest {
  id: string;
  profileId: string;
  generatedAt: string;
  bullets: GroundedDigestBullet[];
  minutesSaved: number;
  videoCount: number;
  totalDuration: number;
}

export type DigestBuildResult =
  | { status: 'ready'; digest: GroundedDigest; selectedVideoIds: string[] }
  | { status: 'empty' }
  | { status: 'deferred'; reason: string }
  | { status: 'invalid'; reason: string };
