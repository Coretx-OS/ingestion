import express from 'express';
import cors from 'cors';
import { config, validateConfig } from './config.js';
import { corsOptions, logCorsConfig } from './cors.js';
import { runMigrations } from './db/connection.js';
import { preloadAllPrompts } from './llm/prompts.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

// Route imports (to be created)
import { captureRouter } from './routes/capture.js';
import { fixRouter } from './routes/fix.js';
import { recentRouter } from './routes/recent.js';
import { digestRouter } from './routes/digest.js';
import { reviewRouter } from './routes/review.js';
import { youtubeRouter } from './routes/youtube.js';

/**
 * Initialize the Express application
 */
function createApp(): express.Application {
  const app = express();

  // Middleware
  app.use(cors(corsOptions)); // Locked-down CORS
  app.use(express.json({ limit: '1mb' })); // Parse JSON bodies

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes
  app.use('/capture', captureRouter);
  app.use('/fix', fixRouter);
  app.use('/recent', recentRouter);
  app.use('/digest', digestRouter);
  app.use('/review', reviewRouter);
  app.use('/youtube', youtubeRouter);

  // Error handlers (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start the server
 */
async function startServer(): Promise<void> {
  try {
    console.log('🚀 Second Brain OS Backend starting...\n');

    // 1. Validate configuration
    validateConfig();

    // 2. Run database migrations
    runMigrations();

    // 3. Preload LLM prompts
    preloadAllPrompts();

    // 4. Log CORS configuration
    logCorsConfig();

    // 5. Create Express app
    const app = createApp();

    // 6. Start listening
    const port = config.port;
    app.listen(port, () => {
      console.log(`\n✅ Server running on port ${port}`);
      console.log(`   Health check: http://localhost:${port}/health`);
      console.log(`   Environment: ${config.nodeEnv}`);
      console.log(`\n📡 API Endpoints:`);
      console.log(`   POST /capture`);
      console.log(`   POST /fix`);
      console.log(`   GET  /recent`);
      console.log(`   POST /digest/preview`);
      console.log(`   POST /review/preview`);
      console.log(`   POST /youtube/capture`);
      console.log(`\n🎯 Ready to accept requests!\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n👋 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();
