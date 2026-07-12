/**
 * Non-emailing CLI preview harness for transcript-grounded digests.
 *
 * The existing `dry_run` pipeline still has unrelated write side effects
 * (channel/video discovery, video_scores writes), so this harness is a
 * separate, narrower tool: given explicit video IDs, it fetches/caches
 * their transcripts through the real shared provider, builds a grounded
 * digest, and prints it - without ever sending email, and without
 * touching the default tracked database.
 *
 * Usage:
 *   BRIEFING_DB_PATH=/tmp/preview.db npx tsx scripts/previewDigest.ts \
 *     --profile-id demo --video-id gROqcBXoz_c --video-id PRqiGS6fnIM
 *
 * Run it twice with the same BRIEFING_DB_PATH to confirm the second run
 * uses the transcript cache instead of calling the provider again.
 */

import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createYouTubeTranscriptProvider, TranscriptError } from '@secondbrain/core';
import { getDb } from '../src/db/connection.js';
import { buildPolicyKey, getTranscriptFetchDecision, recordTranscriptSuccess, recordTranscriptError } from '../src/db/transcriptRepository.js';
import { assignSegmentIds } from '../src/transcript/segments.js';
import { getConfiguredLanguages, getAllowLanguageFallback } from '../src/transcript/enrichmentService.js';
import { buildDigest, formatDigestText, type DigestVideoInput, type ProfileForDigest } from '../src/digest/generator.js';
import { getSharedLLMClient } from '../src/llm/client.js';

dotenv.config();

interface ParsedArgs {
  videoIds: string[];
  profileId: string;
  profileName: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const videoIds: string[] = [];
  let profileId = 'preview';
  let profileName = 'Preview';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--video-id') videoIds.push(argv[++i]);
    else if (argv[i] === '--profile-id') profileId = argv[++i];
    else if (argv[i] === '--profile-name') profileName = argv[++i];
  }
  return { videoIds, profileId, profileName };
}

/** Refuses to run without an explicit temp path, and refuses any path under the repo's tracked data/ directory - not just the exact default filename. */
function assertSafeDbPath(): string {
  const configured = process.env.BRIEFING_DB_PATH;
  if (!configured) {
    console.error('[preview] Refusing to run: set BRIEFING_DB_PATH to an explicit temporary file path.');
    process.exit(1);
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const trackedDataDir = resolve(join(scriptDir, '..', 'data')) + sep;
  const resolvedConfigured = resolve(configured);
  if (resolvedConfigured === resolve(join(scriptDir, '..', 'data')) || resolvedConfigured.startsWith(trackedDataDir)) {
    console.error(
      '[preview] Refusing to run against the tracked data/ directory. Point BRIEFING_DB_PATH at a temp file (e.g. /tmp/preview.db) instead.'
    );
    process.exit(1);
  }
  return configured;
}

async function main(): Promise<void> {
  const dbPath = assertSafeDbPath();
  console.log(`[preview] Using temporary database: ${dbPath}`);

  const { videoIds, profileId, profileName } = parseArgs(process.argv.slice(2));
  if (videoIds.length === 0) {
    console.error('[preview] Provide at least one --video-id <id>.');
    process.exit(1);
  }

  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO channels (id, channel_id, channel_name) VALUES ('preview-channel', 'preview-channel', 'Preview Channel')`).run();
  db.prepare(`INSERT OR IGNORE INTO user_profiles (id, name) VALUES (?, ?)`).run(profileId, profileName);

  const languages = getConfiguredLanguages();
  const allowLanguageFallback = getAllowLanguageFallback();
  const provider = createYouTubeTranscriptProvider({ languages, allowLanguageFallback });
  const policyKey = buildPolicyKey({ provider: provider.name, languages, allowLanguageFallback });

  const videos: DigestVideoInput[] = [];

  for (const videoId of videoIds) {
    db.prepare(
      `INSERT OR IGNORE INTO videos (id, video_id, channel_id, title, published_at, duration_seconds, status)
       VALUES (?, ?, 'preview-channel', ?, datetime('now'), 0, 'new')`
    ).run(`${videoId}-row`, videoId, `Preview video ${videoId}`);

    const decision = getTranscriptFetchDecision(videoId, policyKey);
    let segments;
    let language: string | null;

    if (decision.action === 'use_cache') {
      console.log(`[preview] ${videoId}: cache hit (${decision.transcript.segments.length} segments)`);
      segments = decision.transcript.segments;
      language = decision.transcript.language;
    } else if (decision.action === 'skip') {
      console.log(`[preview] ${videoId}: skipped (cached unavailable, or a retryable failure not yet due)`);
      continue;
    } else {
      try {
        const result = await provider.fetchTranscript(videoId);
        recordTranscriptSuccess(videoId, policyKey, provider.name, result);
        console.log(`[preview] ${videoId}: fetched live (${result.segments.length} segments, language=${result.language ?? 'unknown'})`);
        segments = result.segments;
        language = result.language;
      } catch (err) {
        const transcriptError =
          err instanceof TranscriptError ? err : new TranscriptError(err instanceof Error ? err.message : 'Unknown error', 'transport_error');
        recordTranscriptError(videoId, policyKey, provider.name, transcriptError);
        console.log(`[preview] ${videoId}: unavailable (${transcriptError.code}, retryable=${transcriptError.retryable})`);
        continue;
      }
    }

    const first = segments[0];
    const last = segments[segments.length - 1];
    const endSeconds = last ? last.startSeconds + last.durationSeconds : 0;
    console.log(`[preview] ${videoId}: language=${language ?? 'unknown'}, spans ${first?.startSeconds ?? 0}s-${endSeconds}s`);

    videos.push({
      videoId,
      title: `Preview video ${videoId}`,
      channelName: 'Preview Channel',
      durationSeconds: Math.round(endSeconds),
      combinedScore: 1,
      segments: assignSegmentIds(videoId, segments),
    });
  }

  if (videos.length === 0) {
    console.log('[preview] No usable transcripts were retrieved; nothing to build.');
    return;
  }

  const profile: ProfileForDigest = { id: profileId, name: profileName, interests: [], projects: [], strategyThemes: [] };
  const result = await buildDigest(getSharedLLMClient(), profile, videos);

  if (result.status !== 'ready') {
    console.log(`[preview] Digest build result: ${result.status}`);
    return;
  }

  console.log(`\n${formatDigestText(result.digest)}`);
  console.log('\n[preview] No email was sent. Re-run with the same BRIEFING_DB_PATH to confirm cache reuse.');
}

main().catch((err) => {
  console.error('[preview] Fatal error:', err);
  process.exit(1);
});
