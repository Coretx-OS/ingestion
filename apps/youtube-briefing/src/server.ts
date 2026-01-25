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
  generateDigest,
  formatDigestText,
  formatDigestHtml,
  getRecentDigests,
} from './digest/generator.js';
import {
  sendDigestEmail,
  sendDigestToSubscribers,
  addSubscriber,
  removeSubscriber,
  listSubscribers,
} from './email/sender.js';

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
 * POST /jobs/youtube/generate-digest
 * 
 * Generate a digest for a profile.
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
    
    const digest = await generateDigest(profileId, maxVideos);
    
    console.log(`[GenerateDigest] Generated: ${digest.bullets.length} bullets, saved ${digest.minutesSaved} min`);
    
    res.json(digest);
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
 * Generate and send a digest to all subscribers.
 * Query params:
 *   - profile_id: Profile to generate/send for (required)
 *   - dry_run: If true, generate but don't send email
 */
app.post('/jobs/youtube/send-digest', async (req, res) => {
  try {
    const profileId = req.query.profile_id as string;
    const dryRun = req.query.dry_run === 'true';
    
    if (!profileId) {
      return res.status(400).json({ error: 'profile_id is required' });
    }
    
    console.log(`[SendDigest] Generating for profile ${profileId}${dryRun ? ' (dry run)' : ''}...`);
    
    // Generate digest
    const digest = await generateDigest(profileId);
    
    if (digest.bullets.length === 0) {
      return res.json({
        message: 'No videos to include in digest',
        digest,
        sent: 0,
      });
    }
    
    if (dryRun) {
      return res.json({
        message: 'Dry run - digest generated but not sent',
        digest,
        dryRun: true,
      });
    }
    
    // Send to subscribers
    const sendResult = await sendDigestToSubscribers(digest);
    
    console.log(`[SendDigest] Sent to ${sendResult.sent} subscribers`);
    
    res.json({
      message: `Sent to ${sendResult.sent} subscribers`,
      digest,
      ...sendResult,
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
