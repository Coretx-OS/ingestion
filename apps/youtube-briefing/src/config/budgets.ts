/**
 * Transcript Grounding Execution Budgets
 *
 * Conservative first-release defaults from the transcript grounding plan,
 * overridable via environment variables. These are the hard pre-call
 * controls for candidate selection, live provider calls, retry/recheck
 * timing, and LLM prompt/output/time/concurrency limits.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const TRANSCRIPT_BUDGETS = {
  /** Ranked candidate rows examined per profile, after cache eligibility filtering. */
  rankedCandidateRows: envInt('BUDGET_RANKED_CANDIDATE_ROWS', 30),
  /** Live transcript provider attempts per run; cache hits do not count. */
  liveProviderAttemptsPerRun: envInt('BUDGET_LIVE_PROVIDER_ATTEMPTS', 20),
  /** One total deadline (ms) per video across all provider fallbacks/language attempts. */
  providerDeadlineMs: envInt('BUDGET_PROVIDER_DEADLINE_MS', 12_000),

  /** Retryable failures remain eligible for this many days beyond the normal 24h freshness window. */
  retryHorizonDays: envInt('BUDGET_RETRY_HORIZON_DAYS', 7),
  /** Retry backoff schedule (seconds); attempts beyond the schedule length repeat the last entry. */
  retryScheduleSeconds: [15 * 60, 2 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60],
  /** "Unavailable" recheck TTL (days) before a cached negative outcome is retried again under the same policy. */
  unavailableRecheckDays: envInt('BUDGET_UNAVAILABLE_RECHECK_DAYS', 30),

  /** Complete serialized final-prompt input ceiling (chars), shared by direct and overflow modes. */
  finalDigestInputChars: envInt('BUDGET_FINAL_DIGEST_INPUT_CHARS', 72_000),
  /** Direct transcript windows or accumulated overflow evidence content payload (chars). */
  finalDigestContentChars: envInt('BUDGET_FINAL_DIGEST_CONTENT_CHARS', 60_000),
  /** Reserved for prompt/profile/metadata overhead (chars); finalDigestInputChars - finalDigestContentChars. */
  finalDigestOverheadChars: envInt('BUDGET_FINAL_DIGEST_OVERHEAD_CHARS', 12_000),

  /** Overflow chunk text per evidence call (chars), complete segments only. */
  overflowChunkChars: envInt('BUDGET_OVERFLOW_CHUNK_CHARS', 24_000),
  /** Complete-segment overlap between adjacent overflow chunks (chars). */
  overflowChunkOverlapChars: envInt('BUDGET_OVERFLOW_CHUNK_OVERLAP_CHARS', 1_000),
  /** Overflow evidence-extraction calls reserved per profile. */
  overflowEvidenceCallsPerProfile: envInt('BUDGET_OVERFLOW_EVIDENCE_CALLS', 6),
  /** Maximum concurrent overflow evidence calls. */
  overflowEvidenceConcurrency: envInt('BUDGET_OVERFLOW_EVIDENCE_CONCURRENCY', 2),
  /** Maximum evidence candidates returned per overflow call. */
  overflowEvidenceCandidatesPerCall: envInt('BUDGET_OVERFLOW_EVIDENCE_CANDIDATES', 3),
  /** Maximum segment span (inclusive) a single evidence reference may cover, keeping excerpts bounded and reviewable. */
  maxEvidenceSpanSegments: envInt('BUDGET_MAX_EVIDENCE_SPAN_SEGMENTS', 40),
  /** Output token cap per overflow evidence call. */
  overflowEvidenceOutputTokens: envInt('BUDGET_OVERFLOW_EVIDENCE_OUTPUT_TOKENS', 800),

  /** Output token cap for the one reserved final digest call per profile. */
  finalDigestOutputTokens: envInt('BUDGET_FINAL_DIGEST_OUTPUT_TOKENS', 2_000),
  /** Total LLM deadline (ms) per profile, covering overflow extraction plus the reserved final call. */
  profileLlmDeadlineMs: envInt('BUDGET_PROFILE_LLM_DEADLINE_MS', 120_000),

  /** Transcript cache/segment schema version; bump to invalidate all prior cached transcripts. */
  segmentSchemaVersion: 1,
} as const;

/**
 * Backoff delay (seconds) before the next retry attempt, given the retry
 * attempt count *after* incrementing for the failure just recorded.
 * Attempts beyond the configured schedule repeat its last (daily) entry.
 */
export function retryDelaySeconds(attemptCount: number): number {
  const schedule = TRANSCRIPT_BUDGETS.retryScheduleSeconds;
  const index = Math.min(Math.max(attemptCount, 1), schedule.length) - 1;
  return schedule[index];
}
