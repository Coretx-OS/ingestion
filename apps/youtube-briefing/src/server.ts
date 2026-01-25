/**
 * YouTube Briefing Server
 * 
 * HTTP server for the YouTube Daily Briefing instance.
 * Provides job endpoints for channel monitoring.
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
║  Endpoints:                                              ║
║    POST /jobs/youtube/channel-monitor?dry_run=true       ║
║    POST /channels                                        ║
║    GET  /channels                                        ║
║    GET  /videos/new                                      ║
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
