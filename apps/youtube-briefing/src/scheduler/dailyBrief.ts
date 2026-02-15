/**
 * Daily Brief Job
 * 
 * Orchestrates the full daily briefing pipeline:
 * 1. Monitor channels for new videos
 * 2. Score videos for relevance/novelty
 * 3. Generate digest
 * 4. Send to subscribers (unless dry run)
 * 
 * Designed to be triggered by:
 * - Cloud Scheduler (POST /jobs/daily-brief)
 * - Manual trigger (POST /jobs/daily-brief?dry_run=true)
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db/connection.js';
import { runChannelMonitor } from '../jobs/channelMonitor.js';
import { scoreVideos, getActiveProfiles } from '../relevance/engine.js';
import { generateDigest, type Digest } from '../digest/generator.js';
import { sendDigestToSubscribers } from '../email/sender.js';

export interface DailyBriefResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  dryRun: boolean;
  trigger: 'scheduled' | 'manual';
  
  // Pipeline results
  channelMonitor: {
    channelsChecked: number;
    videosFound: number;
    videosNew: number;
  };
  scoring: {
    profilesProcessed: number;
    videosScored: number;
  };
  digests: Array<{
    profileId: string;
    profileName: string;
    bulletCount: number;
    minutesSaved: number;
    emailsSent: number;
    emailsFailed: number;
  }>;
  
  errors: string[];
}

export interface DailyBriefOptions {
  dryRun?: boolean;
  trigger?: 'scheduled' | 'manual';
  profileIds?: string[];  // Limit to specific profiles (optional)
}

/**
 * Run the full daily brief pipeline
 */
export async function runDailyBrief(options: DailyBriefOptions = {}): Promise<DailyBriefResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const trigger = options.trigger ?? 'manual';
  const errors: string[] = [];
  
  const db = getDb();
  
  // Record run start
  db.prepare(`
    INSERT INTO daily_brief_runs (id, started_at, status, dry_run, trigger_type)
    VALUES (?, ?, 'running', ?, ?)
  `).run(runId, startedAt, dryRun ? 1 : 0, trigger);
  
  const result: DailyBriefResult = {
    runId,
    startedAt,
    completedAt: '',
    status: 'completed',
    dryRun,
    trigger,
    channelMonitor: { channelsChecked: 0, videosFound: 0, videosNew: 0 },
    scoring: { profilesProcessed: 0, videosScored: 0 },
    digests: [],
    errors: [],
  };
  
  try {
    // Step 1: Monitor channels
    console.log(`[DailyBrief] Step 1: Monitoring channels...`);
    const monitorResult = await runChannelMonitor(dryRun);
    result.channelMonitor = {
      channelsChecked: monitorResult.channelsChecked,
      videosFound: monitorResult.videosFound,
      videosNew: monitorResult.videosNew,
    };
    errors.push(...monitorResult.errors);
    
    // Step 2: Get active profiles
    let profiles = getActiveProfiles();
    if (options.profileIds && options.profileIds.length > 0) {
      profiles = profiles.filter(p => options.profileIds!.includes(p.id));
    }
    
    if (profiles.length === 0) {
      console.log(`[DailyBrief] No active profiles found`);
      result.completedAt = new Date().toISOString();
      result.errors = errors;
      updateRunRecord(runId, result);
      return result;
    }
    
    // Step 3: Score and generate digests for each profile
    for (const profile of profiles) {
      try {
        console.log(`[DailyBrief] Step 2: Scoring videos for ${profile.name}...`);
        const scores = await scoreVideos(profile.id);
        result.scoring.videosScored += scores.length;
        result.scoring.profilesProcessed++;
        
        console.log(`[DailyBrief] Step 3: Generating digest for ${profile.name}...`);
        const digest = await generateDigest(profile.id);
        
        let emailsSent = 0;
        let emailsFailed = 0;
        
        if (!dryRun && digest.bullets.length > 0) {
          console.log(`[DailyBrief] Step 4: Sending digest for ${profile.name}...`);
          const sendResult = await sendDigestToSubscribers(digest);
          emailsSent = sendResult.sent;
          emailsFailed = sendResult.failed;
        }
        
        result.digests.push({
          profileId: profile.id,
          profileName: profile.name,
          bulletCount: digest.bullets.length,
          minutesSaved: digest.minutesSaved,
          emailsSent,
          emailsFailed,
        });
        
      } catch (err) {
        const errorMsg = `Profile ${profile.name}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(errorMsg);
        console.error(`[DailyBrief] Error: ${errorMsg}`);
      }
    }
    
    result.completedAt = new Date().toISOString();
    result.errors = errors;
    
    if (errors.length > 0) {
      result.status = 'completed'; // Partial success
    }
    
  } catch (err) {
    result.status = 'failed';
    result.completedAt = new Date().toISOString();
    result.errors = [err instanceof Error ? err.message : 'Unknown error', ...errors];
  }
  
  updateRunRecord(runId, result);
  return result;
}

function updateRunRecord(runId: string, result: DailyBriefResult): void {
  const db = getDb();
  
  db.prepare(`
    UPDATE daily_brief_runs 
    SET completed_at = ?,
        status = ?,
        channels_checked = ?,
        videos_found = ?,
        videos_new = ?,
        profiles_processed = ?,
        videos_scored = ?,
        digests_generated = ?,
        emails_sent = ?,
        execution_json = ?
    WHERE id = ?
  `).run(
    result.completedAt,
    result.status,
    result.channelMonitor.channelsChecked,
    result.channelMonitor.videosFound,
    result.channelMonitor.videosNew,
    result.scoring.profilesProcessed,
    result.scoring.videosScored,
    result.digests.length,
    result.digests.reduce((sum, d) => sum + d.emailsSent, 0),
    JSON.stringify(result),
    runId
  );
}

/**
 * Get recent daily brief runs
 */
export function getRecentRuns(limit: number = 10): DailyBriefResult[] {
  const db = getDb();
  
  const rows = db.prepare(`
    SELECT execution_json FROM daily_brief_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as Array<{ execution_json: string }>;
  
  return rows.map(row => JSON.parse(row.execution_json) as DailyBriefResult);
}
