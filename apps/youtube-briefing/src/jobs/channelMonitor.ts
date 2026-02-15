/**
 * Channel Monitor Job
 * 
 * Polls configured YouTube channels for new videos.
 * Stores discovered videos in the database with 'new' status.
 * 
 * Idempotent: safe to rerun, uses unique constraint on video_id.
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db/connection.js';
import { getChannelInfo, getChannelVideos, type VideoInfo, type ChannelInfo } from '../adapters/youtube.js';

export interface MonitorResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  dryRun: boolean;
  channelsChecked: number;
  videosFound: number;
  videosNew: number;
  errors: string[];
  newVideos: VideoInfo[];
}

interface ChannelRow {
  id: string;
  channel_id: string;
  channel_name: string | null;
  uploads_playlist_id: string | null;
  last_video_published_at: string | null;
}

/**
 * Run the channel monitor
 * 
 * @param dryRun - If true, don't write to database
 */
export async function runChannelMonitor(dryRun: boolean = false): Promise<MonitorResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const allNewVideos: VideoInfo[] = [];
  
  const db = getDb();
  
  // Record run start (unless dry run)
  if (!dryRun) {
    db.prepare(`
      INSERT INTO monitor_runs (id, started_at, status, dry_run)
      VALUES (?, ?, 'running', ?)
    `).run(runId, startedAt, 0);
  }

  try {
    // Get all configured channels
    const channels = db.prepare(`
      SELECT id, channel_id, channel_name, uploads_playlist_id, last_video_published_at
      FROM channels
    `).all() as ChannelRow[];

    let channelsChecked = 0;
    let videosFound = 0;
    let videosNew = 0;

    for (const channel of channels) {
      try {
        // Ensure we have uploads playlist ID
        let uploadsPlaylistId = channel.uploads_playlist_id;
        
        if (!uploadsPlaylistId) {
          const info = await getChannelInfo(channel.channel_id);
          uploadsPlaylistId = info.uploadsPlaylistId;
          
          if (!dryRun) {
            db.prepare(`
              UPDATE channels 
              SET uploads_playlist_id = ?, channel_name = ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(uploadsPlaylistId, info.channelName, channel.id);
          }
        }

        // Fetch videos published after last known video
        const videos = await getChannelVideos(
          uploadsPlaylistId,
          channel.channel_id,
          channel.last_video_published_at || undefined,
          50
        );

        videosFound += videos.length;
        channelsChecked++;

        // Insert new videos
        for (const video of videos) {
          if (!dryRun) {
            try {
              db.prepare(`
                INSERT INTO videos (
                  id, video_id, channel_id,
                  title, description, published_at,
                  duration_seconds, thumbnail_url, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
              `).run(
                randomUUID(),
                video.videoId,
                video.channelId,
                video.title,
                video.description,
                video.publishedAt,
                video.durationSeconds,
                video.thumbnailUrl
              );
              
              videosNew++;
              allNewVideos.push(video);
            } catch (err) {
              // Unique constraint violation = already exists, skip
              if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
                continue;
              }
              throw err;
            }
          } else {
            // In dry run, check if video exists
            const exists = db.prepare(
              'SELECT 1 FROM videos WHERE video_id = ?'
            ).get(video.videoId);
            
            if (!exists) {
              videosNew++;
              allNewVideos.push(video);
            }
          }
        }

        // Update checkpoint
        if (!dryRun && videos.length > 0) {
          const latestPublished = videos.reduce((latest, v) => 
            v.publishedAt > latest ? v.publishedAt : latest,
            channel.last_video_published_at || ''
          );
          
          db.prepare(`
            UPDATE channels 
            SET last_video_published_at = ?, last_checked_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
          `).run(latestPublished, channel.id);
        } else if (!dryRun) {
          db.prepare(`
            UPDATE channels SET last_checked_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
          `).run(channel.id);
        }

      } catch (err) {
        const errorMsg = `Channel ${channel.channel_id}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    const completedAt = new Date().toISOString();
    
    // Update run record
    if (!dryRun) {
      db.prepare(`
        UPDATE monitor_runs 
        SET completed_at = ?, status = 'completed',
            channels_checked = ?, videos_found = ?, videos_new = ?,
            execution_json = ?
        WHERE id = ?
      `).run(
        completedAt,
        channelsChecked,
        videosFound,
        videosNew,
        JSON.stringify({ errors }),
        runId
      );
    }

    return {
      runId,
      startedAt,
      completedAt,
      status: 'completed',
      dryRun,
      channelsChecked,
      videosFound,
      videosNew,
      errors,
      newVideos: allNewVideos,
    };

  } catch (err) {
    const completedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    
    if (!dryRun) {
      db.prepare(`
        UPDATE monitor_runs 
        SET completed_at = ?, status = 'failed', error_message = ?
        WHERE id = ?
      `).run(completedAt, errorMsg, runId);
    }

    return {
      runId,
      startedAt,
      completedAt,
      status: 'failed',
      dryRun,
      channelsChecked: 0,
      videosFound: 0,
      videosNew: 0,
      errors: [errorMsg, ...errors],
      newVideos: [],
    };
  }
}

/**
 * Add a channel to monitor
 */
export async function addChannel(channelId: string): Promise<ChannelInfo> {
  const db = getDb();
  
  // Check if already exists
  const existing = db.prepare(
    'SELECT id FROM channels WHERE channel_id = ?'
  ).get(channelId);
  
  if (existing) {
    throw new Error(`Channel ${channelId} is already configured`);
  }
  
  // Fetch channel info from YouTube
  const info = await getChannelInfo(channelId);
  
  // Insert channel
  db.prepare(`
    INSERT INTO channels (id, channel_id, channel_name, uploads_playlist_id)
    VALUES (?, ?, ?, ?)
  `).run(randomUUID(), info.channelId, info.channelName, info.uploadsPlaylistId);
  
  return info;
}

/**
 * List configured channels
 */
export function listChannels(): ChannelRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM channels ORDER BY channel_name').all() as ChannelRow[];
}

/**
 * Get new (unprocessed) videos
 */
export function getNewVideos(limit: number = 50): VideoInfo[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT video_id, channel_id, title, description, published_at, 
           duration_seconds, thumbnail_url
    FROM videos 
    WHERE status = 'new'
    ORDER BY published_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    video_id: string;
    channel_id: string;
    title: string;
    description: string | null;
    published_at: string;
    duration_seconds: number;
    thumbnail_url: string | null;
  }>;
  
  return rows.map(row => ({
    videoId: row.video_id,
    channelId: row.channel_id,
    title: row.title,
    description: row.description || '',
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds,
    thumbnailUrl: row.thumbnail_url,
  }));
}
