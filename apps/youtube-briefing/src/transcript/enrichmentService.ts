/**
 * Bounded Transcript Enrichment
 *
 * Walks ranked candidates (metadata relevance/novelty scoring already
 * happened upstream) in score order, using cached transcripts first and
 * fetching live only until `maxVideos` usable transcripts are found or a
 * bound is reached. An individual candidate's transcript failure never
 * throws - it is recorded in the cache and enrichment continues to the
 * next lower-ranked candidate. Never logs transcript content.
 */

import { createYouTubeTranscriptProvider, TranscriptError, type TranscriptProvider } from '@secondbrain/core';
import { TRANSCRIPT_BUDGETS } from '../config/budgets.js';
import {
  buildPolicyKey,
  getTranscriptFetchDecision,
  recordTranscriptSuccess,
  recordTranscriptError,
  type CachedTranscript,
} from '../db/transcriptRepository.js';
import { getEnrichmentCandidates, type EnrichmentCandidate } from './candidates.js';

export interface EnrichedVideo extends EnrichmentCandidate {
  transcript: CachedTranscript;
}

export interface EnrichmentStats {
  candidatesExamined: number;
  cacheHits: number;
  liveFetchAttempts: number;
  fetched: number;
  unavailable: number;
  retryableFailures: number;
  deferredBudget: number;
  usable: number;
}

export interface EnrichmentResult {
  videos: EnrichedVideo[];
  stats: EnrichmentStats;
}

/**
 * Shared, mutable live-provider-attempt budget for one `runDailyBrief`
 * invocation. Must be created ONCE per run and passed into every profile's
 * `enrichCandidatesWithTranscripts` call - the budget is per RUN, not per
 * profile; a fresh counter per profile would let N profiles make N times
 * the intended number of live provider calls.
 */
export interface RunTranscriptBudget {
  liveFetchAttemptsRemaining: number;
}

export function createRunTranscriptBudget(): RunTranscriptBudget {
  return { liveFetchAttemptsRemaining: TRANSCRIPT_BUDGETS.liveProviderAttemptsPerRun };
}

export function getConfiguredLanguages(): string[] {
  const raw = process.env.TRANSCRIPT_LANGUAGES;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether to retry without a language constraint once configured languages
 * are exhausted. Defaults to true (prefer getting *some* transcript over
 * none) regardless of whether TRANSCRIPT_LANGUAGES is set - previously this
 * was silently forced to false whenever any language was configured,
 * because the provider was never given an explicit value at all.
 */
export function getAllowLanguageFallback(): boolean {
  const raw = process.env.TRANSCRIPT_ALLOW_LANGUAGE_FALLBACK;
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== 'false';
}

let sharedProvider: TranscriptProvider | null = null;

function getProvider(): TranscriptProvider {
  if (sharedProvider) return sharedProvider;
  sharedProvider = createYouTubeTranscriptProvider({
    languages: getConfiguredLanguages(),
    allowLanguageFallback: getAllowLanguageFallback(),
    deadlineMs: TRANSCRIPT_BUDGETS.providerDeadlineMs,
  });
  return sharedProvider;
}

/** Test-only seam to inject a mock provider without touching the network. */
export function __setProviderForTests(provider: TranscriptProvider | null): void {
  sharedProvider = provider;
}

function emptyStats(): EnrichmentStats {
  return {
    candidatesExamined: 0,
    cacheHits: 0,
    liveFetchAttempts: 0,
    fetched: 0,
    unavailable: 0,
    retryableFailures: 0,
    deferredBudget: 0,
    usable: 0,
  };
}

export async function enrichCandidatesWithTranscripts(
  profileId: string,
  maxVideos: number,
  runBudget: RunTranscriptBudget
): Promise<EnrichmentResult> {
  const provider = getProvider();
  const languages = getConfiguredLanguages();
  const policyKey = buildPolicyKey({
    provider: provider.name,
    languages,
    allowLanguageFallback: getAllowLanguageFallback(),
  });

  const candidates = getEnrichmentCandidates(profileId, TRANSCRIPT_BUDGETS.rankedCandidateRows, policyKey);
  const stats = emptyStats();
  const videos: EnrichedVideo[] = [];

  for (const candidate of candidates) {
    if (videos.length >= maxVideos) break;
    stats.candidatesExamined++;

    const decision = getTranscriptFetchDecision(candidate.videoId, policyKey);

    if (decision.action === 'skip') {
      continue;
    }

    if (decision.action === 'use_cache') {
      stats.cacheHits++;
      stats.usable++;
      videos.push({ ...candidate, transcript: decision.transcript });
      continue;
    }

    // decision.action === 'fetch'
    if (runBudget.liveFetchAttemptsRemaining <= 0) {
      stats.deferredBudget++;
      continue;
    }
    runBudget.liveFetchAttemptsRemaining--;
    stats.liveFetchAttempts++;

    try {
      const result = await provider.fetchTranscript(candidate.videoId);
      recordTranscriptSuccess(candidate.videoId, policyKey, provider.name, result);
      stats.fetched++;
      stats.usable++;
      videos.push({
        ...candidate,
        transcript: { videoId: candidate.videoId, language: result.language, segments: result.segments },
      });
    } catch (err) {
      const transcriptError =
        err instanceof TranscriptError
          ? err
          : new TranscriptError(err instanceof Error ? err.message : 'Unknown transcript error', 'transport_error');
      recordTranscriptError(candidate.videoId, policyKey, provider.name, transcriptError);
      if (transcriptError.retryable) {
        stats.retryableFailures++;
      } else {
        stats.unavailable++;
      }
    }
  }

  return { videos, stats };
}
