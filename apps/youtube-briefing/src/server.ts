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
