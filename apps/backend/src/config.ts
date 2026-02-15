import { config as loadEnv } from 'dotenv';

// Load .env file
loadEnv();

/**
 * Application configuration loaded from environment variables
 *
 * All configuration is centralized here for easy access throughout the app.
 */
export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',

  // Database
  databasePath: process.env.DATABASE_PATH || './data/secondbrain.db',

  // CORS (locked down - no wildcard)
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) || ['http://localhost:3000'],

  // YouTube feature
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  transcriptProvider: process.env.TRANSCRIPT_PROVIDER || 'youtube-transcript',
} as const;

/**
 * Validate required configuration
 * Throws if critical config is missing
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.openaiApiKey) {
    errors.push('OPENAI_API_KEY is required');
  }

  if (!config.allowedOrigins || config.allowedOrigins.length === 0) {
    errors.push('ALLOWED_ORIGINS is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  console.log('✅ Configuration validated');
  console.log(`   Model: ${config.llmModel}`);
  console.log(`   Database: ${config.databasePath}`);
  console.log(`   CORS Origins: ${config.allowedOrigins.join(', ')}`);

  // YouTube feature - optional but warn if not configured
  if (!config.youtubeApiKey) {
    console.log('⚠️  YOUTUBE_API_KEY not set - YouTube capture will fail at metadata stage');
  } else {
    console.log(`   YouTube: API key configured, provider: ${config.transcriptProvider}`);
  }
}
