/**
 * Standalone daily brief runner, for cron/systemd invocation.
 *
 * Runs the full pipeline (channel monitor -> score -> enrich -> digest ->
 * email) once and exits, independent of the HTTP server. Loads apps/
 * youtube-briefing/.env the same way the server does.
 *
 * Usage:
 *   npx tsx scripts/runDailyBrief.ts [--dry-run] [--profile-id=...]
 */

import dotenv from 'dotenv';
import { runDailyBrief } from '../src/scheduler/dailyBrief.js';

dotenv.config();

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const profileArg = argv.find((a) => a.startsWith('--profile-id='));
  const profileIds = profileArg ? [profileArg.split('=')[1]] : undefined;
  return { dryRun, profileIds };
}

async function main() {
  const { dryRun, profileIds } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  console.log(`[runDailyBrief] Starting at ${startedAt}${dryRun ? ' (dry run)' : ''}...`);

  const result = await runDailyBrief({ trigger: 'scheduled', dryRun, profileIds });

  console.log(JSON.stringify(result, null, 2));

  const emailsSent = result.profiles.reduce((sum, p) => sum + p.emailsSent, 0);
  const emailsFailed = result.profiles.reduce((sum, p) => sum + p.emailsFailed, 0);
  console.log(
    `[runDailyBrief] Completed: status=${result.status}, digests=${result.digestsGenerated}, emailsSent=${emailsSent}, emailsFailed=${emailsFailed}`
  );

  if (result.status !== 'completed' || emailsFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[runDailyBrief] Fatal error:', error);
  process.exitCode = 1;
});
