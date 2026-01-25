/**
 * Digest Generator
 * 
 * Generates daily executive briefing from top-scoring videos.
 * Uses LLM to create bullet points with timestamps and relevance.
 */

import { randomUUID } from 'crypto';
import { createOpenAIClient, type LLMClient } from '@secondbrain/core';
import { getDb } from '../db/connection.js';
import { getTopVideos, type ScoredVideo } from '../relevance/engine.js';

export interface DigestBullet {
  videoId: string;
  videoTitle: string;
  bullet: string;
  whyItMatters: string;
  timestampUrl: string;
  tags: string[];
}

export interface Digest {
  id: string;
  profileId: string;
  generatedAt: string;
  bullets: DigestBullet[];
  minutesSaved: number;
  videoCount: number;
  totalDuration: number;
}

interface VideoWithTranscript {
  videoId: string;
  title: string;
  description: string;
  durationSeconds: number;
  channelName: string | null;
  relevanceScore: number;
  noveltyScore: number;
}

interface LLMBulletResponse {
  bullets: Array<{
    videoId: string;
    bullet: string;
    whyItMatters: string;
    timestampSeconds: number;
    tags: string[];
  }>;
}

let llmClient: LLMClient | null = null;

function getLLM(): LLMClient {
  if (llmClient) return llmClient;
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }
  
  llmClient = createOpenAIClient({
    apiKey,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  });
  
  return llmClient;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getTimestampUrl(videoId: string, seconds: number): string {
  return `https://youtube.com/watch?v=${videoId}&t=${seconds}`;
}

const DIGEST_PROMPT = `You are an executive briefing assistant. Given video metadata, generate concise bullet points for a daily briefing.

For each video, produce:
1. A single punchy bullet point (max 20 words) capturing the key insight
2. A "why it matters" sentence connecting to business/strategy themes
3. A timestamp (in seconds) pointing to the most valuable moment
4. 2-3 topic tags

Output JSON only:
{
  "bullets": [
    {
      "videoId": "...",
      "bullet": "...",
      "whyItMatters": "...",
      "timestampSeconds": 0,
      "tags": ["tag1", "tag2"]
    }
  ]
}

Be concise. No fluff. Focus on actionable insights.`;

/**
 * Generate digest for a profile from top videos
 */
export async function generateDigest(
  profileId: string,
  maxVideos: number = 10
): Promise<Digest> {
  const db = getDb();
  const llm = getLLM();
  
  // Get top-scoring videos
  const scoredVideos = getTopVideos(profileId, maxVideos);
  
  if (scoredVideos.length === 0) {
    return {
      id: randomUUID(),
      profileId,
      generatedAt: new Date().toISOString(),
      bullets: [],
      minutesSaved: 0,
      videoCount: 0,
      totalDuration: 0,
    };
  }
  
  // Fetch full video details
  const videoIds = scoredVideos.map(v => v.videoId);
  const placeholders = videoIds.map(() => '?').join(',');
  
  const videoRows = db.prepare(`
    SELECT v.video_id, v.title, v.description, v.duration_seconds, c.channel_name
    FROM videos v
    LEFT JOIN channels c ON c.channel_id = v.channel_id
    WHERE v.video_id IN (${placeholders})
  `).all(...videoIds) as Array<{
    video_id: string;
    title: string;
    description: string | null;
    duration_seconds: number;
    channel_name: string | null;
  }>;
  
  // Map scores to videos
  const scoreMap = new Map(scoredVideos.map(v => [v.videoId, v]));
  
  const videos: VideoWithTranscript[] = videoRows.map(row => ({
    videoId: row.video_id,
    title: row.title,
    description: row.description || '',
    durationSeconds: row.duration_seconds,
    channelName: row.channel_name,
    relevanceScore: scoreMap.get(row.video_id)?.relevanceScore || 0,
    noveltyScore: scoreMap.get(row.video_id)?.noveltyScore || 0,
  }));
  
  // Calculate total duration
  const totalDuration = videos.reduce((sum, v) => sum + v.durationSeconds, 0);
  
  // Prepare input for LLM
  const videoSummaries = videos.map(v => ({
    videoId: v.videoId,
    title: v.title,
    channel: v.channelName || 'Unknown',
    description: v.description.substring(0, 500),
    durationMinutes: Math.round(v.durationSeconds / 60),
    relevanceScore: v.relevanceScore.toFixed(2),
  }));
  
  // Call LLM
  const result = await llm.call({
    role: 'digest-generator',
    prompt: DIGEST_PROMPT,
    input: JSON.stringify({ videos: videoSummaries }),
  });
  
  // Parse response
  let llmResponse: LLMBulletResponse;
  try {
    const raw = typeof result.raw === 'string' ? result.raw : JSON.stringify(result.raw);
    // Handle markdown code blocks
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    llmResponse = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse LLM response:', result.raw);
    throw new Error('Failed to parse digest response');
  }
  
  // Build bullets with URLs
  const bullets: DigestBullet[] = llmResponse.bullets.map(b => {
    const video = videos.find(v => v.videoId === b.videoId);
    return {
      videoId: b.videoId,
      videoTitle: video?.title || '',
      bullet: b.bullet,
      whyItMatters: b.whyItMatters,
      timestampUrl: getTimestampUrl(b.videoId, b.timestampSeconds),
      tags: b.tags,
    };
  });
  
  // Minutes saved = total video duration - ~2 min reading time
  const minutesSaved = Math.max(0, Math.round(totalDuration / 60) - 2);
  
  const digest: Digest = {
    id: randomUUID(),
    profileId,
    generatedAt: new Date().toISOString(),
    bullets,
    minutesSaved,
    videoCount: videos.length,
    totalDuration,
  };
  
  // Store digest
  db.prepare(`
    INSERT INTO digests (id, profile_id, generated_at, digest_json, minutes_saved, video_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    digest.id,
    digest.profileId,
    digest.generatedAt,
    JSON.stringify(digest),
    digest.minutesSaved,
    digest.videoCount
  );
  
  return digest;
}

/**
 * Format digest as plain text for email
 */
export function formatDigestText(digest: Digest): string {
  const lines: string[] = [];
  
  lines.push('📺 Daily YouTube Strategic Briefing');
  lines.push('═'.repeat(40));
  lines.push('');
  
  for (let i = 0; i < digest.bullets.length; i++) {
    const bullet = digest.bullets[i];
    lines.push(`${i + 1}. ${bullet.bullet}`);
    lines.push(`   → ${bullet.whyItMatters}`);
    lines.push(`   🔗 ${bullet.timestampUrl}`);
    lines.push(`   #${bullet.tags.join(' #')}`);
    lines.push('');
  }
  
  lines.push('─'.repeat(40));
  lines.push(`Saved you ${digest.minutesSaved} minutes. You're welcome.`);
  lines.push(`(${digest.videoCount} videos, ${Math.round(digest.totalDuration / 60)} min total)`);
  
  return lines.join('\n');
}

/**
 * Format digest as HTML for email
 */
export function formatDigestHtml(digest: Digest): string {
  const bulletHtml = digest.bullets.map((bullet, i) => `
    <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 8px;">
      <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">
        ${i + 1}. ${escapeHtml(bullet.bullet)}
      </p>
      <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">
        → ${escapeHtml(bullet.whyItMatters)}
      </p>
      <p style="margin: 0;">
        <a href="${bullet.timestampUrl}" style="color: #0066cc; text-decoration: none;">
          ▶ Watch key moment
        </a>
        <span style="color: #999; margin-left: 10px; font-size: 12px;">
          ${bullet.tags.map(t => `#${t}`).join(' ')}
        </span>
      </p>
    </div>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 5px;">📺 Daily YouTube Strategic Briefing</h1>
  <p style="color: #666; margin-top: 0;">${new Date(digest.generatedAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
  
  <hr style="border: none; border-top: 2px solid #eee; margin: 20px 0;">
  
  ${bulletHtml}
  
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  
  <p style="text-align: center; color: #666; font-size: 14px;">
    <strong>Saved you ${digest.minutesSaved} minutes. You're welcome.</strong><br>
    <span style="font-size: 12px;">(${digest.videoCount} videos, ${Math.round(digest.totalDuration / 60)} min total)</span>
  </p>
</body>
</html>
  `.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Get recent digests for a profile
 */
export function getRecentDigests(profileId: string, limit: number = 10): Digest[] {
  const db = getDb();
  
  const rows = db.prepare(`
    SELECT digest_json FROM digests
    WHERE profile_id = ?
    ORDER BY generated_at DESC
    LIMIT ?
  `).all(profileId, limit) as Array<{ digest_json: string }>;
  
  return rows.map(row => JSON.parse(row.digest_json) as Digest);
}
