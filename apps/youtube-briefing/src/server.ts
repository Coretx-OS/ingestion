/**
 * YouTube Briefing Server
 * 
 * HTTP server for the YouTube Daily Briefing instance.
 * Provides job endpoints for channel monitoring and relevance scoring.
 */

import express from 'express';
import dotenv from 'dotenv';
import { getDb, closeDb } from './db/connection.js';
import { 
  runChannelMonitor, 
  addChannel, 
  listChannels, 
  getNewVideos 
} from './jobs/channelMonitor.js';
import {
  upsertProfile,
  getActiveProfiles,
  scoreVideos,
  getTopVideos,
  addKnowledge,
  type UserProfile,
} from './relevance/engine.js';
import {
  buildDigest,
  formatDigestText,
  formatDigestHtml,
  type DigestVideoInput,
  type ProfileForDigest,
} from './digest/generator.js';
import { persistDigest, getRecentDigests } from './digest/persistence.js';
import { enrichCandidatesWithTranscripts, createRunTranscriptBudget } from './transcript/enrichmentService.js';
import { assignSegmentIds } from './transcript/segments.js';
import { getSharedLLMClient } from './llm/client.js';
import {
  sendDigestEmail,
  addSubscriber,
  removeSubscriber,
  listSubscribers,
} from './email/sender.js';
import {
  runDailyBrief,
  getRecentRuns,
  runProfileDigest,
  markVideosProcessed,
  STATUS_SAFE_OUTCOMES,
} from './scheduler/dailyBrief.js';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.BRIEFING_PORT || 3001;

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'youtube-briefing' });
});

/**
 * POST /jobs/youtube/channel-monitor
 * 
 * Run the channel monitor job.
 * Query params:
 *   - dry_run=true: Don't write to database, just return what would be found
 */
app.post('/jobs/youtube/channel-monitor', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true';
    
    console.log(`[ChannelMonitor] Starting${dryRun ? ' (dry run)' : ''}...`);
    
    const result = await runChannelMonitor(dryRun);
    
    console.log(`[ChannelMonitor] Completed: ${result.videosNew} new videos found`);
    
    res.json(result);
  } catch (error) {
    console.error('[ChannelMonitor] Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /jobs/youtube/channel-monitor
 * 
 * Alias for POST (convenience for testing)
 */
app.get('/jobs/youtube/channel-monitor', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true';
    const result = await runChannelMonitor(dryRun);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /channels
 * 
 * Add a channel to monitor.
 * Body: { channelId: string }
 */
app.post('/channels', async (req, res) => {
  try {
    const { channelId } = req.body as { channelId?: string };
    
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }
    
    const info = await addChannel(channelId);
    
    res.status(201).json({
      message: 'Channel added',
      channel: info,
    });
  } catch (error) {
    const status = error instanceof Error && error.message.includes('already configured') ? 409 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /channels
 * 
 * List all configured channels.
 */
app.get('/channels', (_req, res) => {
  try {
    const channels = listChannels();
    res.json({ channels });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /videos/new
 * 
 * Get unprocessed (new) videos.
 * Query params:
 *   - limit: Max videos to return (default 50)
 */
app.get('/videos/new', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const videos = getNewVideos(limit);
    res.json({ videos, count: videos.length });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =================================================================
// PROFILES (Phase 3)
// =================================================================

/**
 * POST /profiles
 * 
 * Create or update a user profile.
 * Body: { id, name, interests, projects, strategyThemes }
 */
app.post('/profiles', async (req, res) => {
  try {
    const profile = req.body as UserProfile;
    
    if (!profile.id || !profile.name) {
      return res.status(400).json({ error: 'id and name are required' });
    }
    
    profile.interests = profile.interests || [];
    profile.projects = profile.projects || [];
    profile.strategyThemes = profile.strategyThemes || [];
    
    await upsertProfile(profile);
    
    res.status(201).json({ message: 'Profile saved', profile });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /profiles
 * 
 * List active user profiles.
 */
app.get('/profiles', (_req, res) => {
  try {
    const profiles = getActiveProfiles();
    res.json({ profiles });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =================================================================
// SCORING (Phase 3)
// =================================================================

/**
 * POST /jobs/youtube/score-videos
 * 
 * Score new videos for relevance and novelty.
 * Query params:
 *   - profile_id: Profile to score against (required)
 */
app.post('/jobs/youtube/score-videos', async (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    
    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }
    
    console.log(`[ScoreVideos] Scoring for profile ${profileId}...`);
    
    const scores = await scoreVideos(profileId);
    
    console.log(`[ScoreVideos] Scored ${scores.length} videos`);
    
    res.json({
      profileId,
      videosScored: scores.length,
      scores,
    });
  } catch (error) {
    console.error('[ScoreVideos] Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /videos/top
 * 
 * Get top-scoring videos for a profile.
 * Query params:
 *   - profile_id: Profile to get scores for (required)
 *   - limit: Max videos to return (default 10)
 */
app.get('/videos/top', (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    const limit = parseInt(req.query.limit as string) || 10;
    
    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }
    
    const videos = getTopVideos(profileId, limit);
    res.json({ videos, count: videos.length });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =================================================================
// KNOWLEDGE BASE (Phase 3)
// =================================================================

/**
 * POST /knowledge
 * 
 * Add a concept to the knowledge base.
 * Body: { concept, source?, sourceId? }
 */
app.post('/knowledge', async (req, res) => {
  try {
    const { concept, source, sourceId } = req.body as { 
      concept?: string; 
      source?: string; 
      sourceId?: string;
    };
    
    if (!concept) {
      return res.status(400).json({ error: 'concept is required' });
    }
    
    await addKnowledge(concept, source, sourceId);
    
    res.status(201).json({ message: 'Knowledge added', concept });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =================================================================
// DIGEST (Phase 4)
// =================================================================

/**
 * Runs enrichment for one profile and returns the pieces
 * `runProfileDigest` needs. Deliberately does not build, persist, or
 * commit anything itself - that is `runProfileDigest`'s job, so this
 * endpoint and the multi-profile daily-brief run apply the exact same
 * outcome/commit contract rather than each deciding independently
 * whether it's safe to mark a video globally processed (see
 * `runProfileDigest`'s doc comment). Calling this repeatedly is safe
 * (candidates stay eligible; the transcript cache still avoids
 * redundant fetches).
 */
async function enrichProfileForDigest(
  profileId: string,
  maxVideos: number
): Promise<{ profileForDigest: ProfileForDigest; videoInputs: DigestVideoInput[] }> {
  const profile = getActiveProfiles().find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(`No active profile found: ${profileId}`);
  }

  // A single ad-hoc call gets its own fresh budget (it isn't part of a
  // shared multi-profile run).
  const enrichment = await enrichCandidatesWithTranscripts(profileId, maxVideos, createRunTranscriptBudget());
  const videoInputs: DigestVideoInput[] = enrichment.videos.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    channelName: v.channelName,
    durationSeconds: v.durationSeconds,
    combinedScore: v.combinedScore,
    segments: assignSegmentIds(v.videoId, v.transcript.segments),
  }));

  const profileForDigest: ProfileForDigest = {
    id: profile.id,
    name: profile.name,
    interests: profile.interests,
    projects: profile.projects,
    strategyThemes: profile.strategyThemes,
  };

  return { profileForDigest, videoInputs };
}

/**
 * Builds - and unless dryRun, persists, sends, and (only if
 * status-safe) commits - a grounded digest for one profile via the same
 * `runProfileDigest`/`STATUS_SAFE_OUTCOMES` contract the multi-profile
 * daily-brief run uses, so a single-profile HTTP call can never mark a
 * video globally processed on a deferred/invalid/failed outcome the way
 * ad-hoc duplicated logic previously could.
 */
async function buildAndCommitDigestForProfile(profileId: string, maxVideos: number, dryRun: boolean) {
  const { profileForDigest, videoInputs } = await enrichProfileForDigest(profileId, maxVideos);
  const profileResult = await runProfileDigest(getSharedLLMClient(), profileForDigest, videoInputs, { dryRun });

  if (!dryRun && STATUS_SAFE_OUTCOMES.has(profileResult.outcome) && profileResult.selectedVideoIds.length > 0) {
    markVideosProcessed(profileResult.selectedVideoIds);
  }

  return profileResult;
}

/**
 * POST /jobs/youtube/generate-digest
 *
 * Generate and persist a grounded digest for a profile, WITHOUT sending
 * it to subscribers or marking any video globally processed - purely a
 * preview/generation tool (see `enrichProfileForDigest`'s doc comment).
 * Use POST /jobs/youtube/send-digest to actually deliver and commit.
 * Query params:
 *   - profile_id: Profile to generate digest for (required)
 *   - max_videos: Max videos to include (default 10)
 */
app.post('/jobs/youtube/generate-digest', async (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    const maxVideos = parseInt(req.query.max_videos as string) || 10;

    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }

    console.log(`[GenerateDigest] Generating for profile ${profileId}...`);

    const { profileForDigest, videoInputs } = await enrichProfileForDigest(profileId, maxVideos);
    const result = await buildDigest(getSharedLLMClient(), profileForDigest, videoInputs);

    if (result.status !== 'ready') {
      console.log(`[GenerateDigest] ${result.status} for profile ${profileId}`);
      return res.json({ status: result.status, digest: null });
    }

    persistDigest(result.digest);

    console.log(`[GenerateDigest] Generated: ${result.digest.bullets.length} bullets, saved ${result.digest.minutesSaved} min`);

    res.json({ status: 'ready', digest: result.digest });
  } catch (error) {
    console.error('[GenerateDigest] Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /digests
 * 
 * Get recent digests for a profile.
 * Query params:
 *   - profile_id: Profile to get digests for (required)
 *   - limit: Max digests to return (default 10)
 */
app.get('/digests', (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    const limit = parseInt(req.query.limit as string) || 10;
    
    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }
    
    const digests = getRecentDigests(profileId, limit);
    res.json({ digests, count: digests.length });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /digests/:id/text
 * 
 * Get a digest formatted as plain text.
 */
app.get('/digests/:id/text', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT digest_json FROM digests WHERE id = ?').get(req.params.id) as { digest_json: string } | undefined;
    
    if (!row) {
      return res.status(404).json({ error: 'Digest not found' });
    }
    
    const digest = JSON.parse(row.digest_json);
    const text = formatDigestText(digest);
    
    res.type('text/plain').send(text);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /digests/:id/html
 * 
 * Get a digest formatted as HTML (for email preview).
 */
app.get('/digests/:id/html', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT digest_json FROM digests WHERE id = ?').get(req.params.id) as { digest_json: string } | undefined;
    
    if (!row) {
      return res.status(404).json({ error: 'Digest not found' });
    }
    
    const digest = JSON.parse(row.digest_json);
    const html = formatDigestHtml(digest);
    
    res.type('text/html').send(html);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =================================================================
// EMAIL (Phase 5)
// =================================================================

/**
 * POST /jobs/youtube/send-digest
 *
 * Generate, persist, and send a digest to all subscribers for one
 * profile - applying the exact same outcome/commit contract as the
 * multi-profile daily-brief run (`runProfileDigest` +
 * `STATUS_SAFE_OUTCOMES`), so a real send from this endpoint marks its
 * videos globally processed exactly when a daily-brief run would have,
 * instead of leaving them eligible to be re-selected and re-sent by a
 * later run.
 * Query params:
 *   - profile_id: Profile to generate/send for (required)
 *   - dry_run: If true, generate but don't persist, send, or commit
 */
app.post('/jobs/youtube/send-digest', async (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    const dryRun = req.query.dry_run === 'true';

    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }

    console.log(`[SendDigest] Generating for profile ${profileId}${dryRun ? ' (dry run)' : ''}...`);

    const profileResult = await buildAndCommitDigestForProfile(profileId, 10, dryRun);

    if (dryRun) {
      return res.json({
        message: 'Dry run - digest generated but not sent',
        status: profileResult.outcome,
        digest: profileResult.digest ?? null,
        dryRun: true,
      });
    }

    if (!profileResult.digest) {
      return res.json({
        message: `No videos to include in digest (${profileResult.outcome})`,
        status: profileResult.outcome,
        sent: 0,
      });
    }

    console.log(`[SendDigest] Sent to ${profileResult.emailsSent} subscribers (outcome: ${profileResult.outcome})`);

    res.json({
      message: `Sent to ${profileResult.emailsSent} subscribers`,
      status: profileResult.outcome,
      digest: profileResult.digest,
      sent: profileResult.emailsSent,
      failed: profileResult.emailsFailed,
    });
  } catch (error) {
    console.error('[SendDigest] Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /subscribers
 * 
 * Add an email subscriber to a profile.
 * Body: { profileId, email }
 */
app.post('/subscribers', (req, res) => {
  try {
    const { profileId, email } = req.body as { profileId?: string; email?: string };
    
    if (!profileId || !email) {
      return res.status(400).json({ error: 'profileId and email are required' });
    }
    
    addSubscriber(profileId, email);
    
    res.status(201).json({ message: 'Subscriber added', profileId, email });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /subscribers
 * 
 * Remove an email subscriber.
 * Body: { profileId, email }
 */
app.delete('/subscribers', (req, res) => {
  try {
    const { profileId, email } = req.body as { profileId?: string; email?: string };
    
    if (!profileId || !email) {
      return res.status(400).json({ error: 'profileId and email are required' });
    }
    
    removeSubscriber(profileId, email);
    
    res.json({ message: 'Subscriber removed', profileId, email });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /subscribers
 * 
 * List subscribers for a profile.
 * Query params:
 *   - profile_id: Profile to list subscribers for (required)
 */
app.get('/subscribers', (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    
    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }
    
    const subscribers = listSubscribers(profileId);
    res.json({ subscribers, count: subscribers.length });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =================================================================
// DAILY BRIEF - FULL PIPELINE (Phase 6)
// =================================================================

/**
 * POST /jobs/daily-brief
 * 
 * Run the full daily briefing pipeline:
 * 1. Monitor channels for new videos
 * 2. Score videos for relevance/novelty
 * 3. Generate digests for all profiles
 * 4. Send to subscribers
 * 
 * Query params:
 *   - dry_run=true: Run pipeline but don't send emails
 *   - profile_id=...: Limit to specific profile (optional)
 * 
 * Designed for Cloud Scheduler or manual trigger.
 */
app.post('/jobs/daily-brief', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true';
    const profileId = req.query.profile_id as string | undefined;
    
    console.log(`[DailyBrief] Starting${dryRun ? ' (dry run)' : ''}...`);
    
    const result = await runDailyBrief({
      dryRun,
      trigger: 'manual',
      profileIds: profileId ? [profileId] : undefined,
    });
    
    console.log(`[DailyBrief] Completed: ${result.digestsGenerated} digests, ${result.profiles.reduce((s, p) => s + p.emailsSent, 0)} emails sent`);
    
    res.json(result);
  } catch (error) {
    console.error('[DailyBrief] Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /jobs/daily-brief
 * 
 * Convenience alias for POST (for browser testing).
 */
app.get('/jobs/daily-brief', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true';
    const result = await runDailyBrief({ dryRun, trigger: 'manual' });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /jobs/daily-brief/history
 * 
 * Get recent daily brief run history.
 * Query params:
 *   - limit: Max runs to return (default 10)
 */
app.get('/jobs/daily-brief/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const runs = getRecentRuns(limit);
    res.json({ runs, count: runs.length });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Startup
function start() {
  // Initialize database
  getDb();
  
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  YouTube Briefing Service                                ║
║  Running on: http://localhost:${PORT}                       ║
╠══════════════════════════════════════════════════════════╣
║  Channel Monitor:                                        ║
║    POST /jobs/youtube/channel-monitor?dry_run=true       ║
║    POST /channels                                        ║
║    GET  /channels                                        ║
║    GET  /videos/new                                      ║
║  Relevance (Phase 3):                                    ║
║    POST /profiles                                        ║
║    GET  /profiles                                        ║
║    POST /jobs/youtube/score-videos?profile_id=...        ║
║    GET  /videos/top?profile_id=...                       ║
║    POST /knowledge                                       ║
║  Digest (Phase 4):                                       ║
║    POST /jobs/youtube/generate-digest?profile_id=...     ║
║    GET  /digests?profile_id=...                          ║
║    GET  /digests/:id/text                                ║
║    GET  /digests/:id/html                                ║
║  Email (Phase 5):                                        ║
║    POST /jobs/youtube/send-digest?profile_id=...         ║
║    POST /subscribers                                     ║
║    DELETE /subscribers                                   ║
║    GET  /subscribers?profile_id=...                      ║
║  Daily Brief Pipeline (Phase 6):                         ║
║    POST /jobs/daily-brief?dry_run=true                   ║
║    GET  /jobs/daily-brief/history                        ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

start();
