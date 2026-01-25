import express, { type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/connection.js';
import { getTranscriptProvider } from '../youtube/transcriptProvider.js';
import { fetchYouTubeMetadata } from '../youtube/metadataFetcher.js';
import { callLLM } from '../llm/client.js';
import { getYouTubeSummaryPrompt } from '../llm/prompts.js';
import type { YouTubeCaptureRequest, YouTubeCaptureResponse } from '@secondbrain/contracts';

export const youtubeRouter = express.Router();

interface ExecutionLog {
  startTime: string;
  stages: Array<{
    stage: string;
    durationMs: number;
    success: boolean;
    error?: string;
  }>;
  totalDurationMs?: number;
}

/**
 * POST /youtube/capture
 *
 * Captures a YouTube video, fetches transcript, generates summary, and stores in database.
 *
 * Pipeline stages:
 * 1. Fetch transcript
 * 2. Fetch metadata
 * 3. Generate LLM summary
 * 4. Store in database
 *
 * Returns minimal response per MVP constraint: { status, recordId, error? }
 */
youtubeRouter.post('/capture', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const recordId = randomUUID();

  const executionLog: ExecutionLog = {
    startTime: new Date().toISOString(),
    stages: [],
  };

  try {
    // Validate request
    const body = req.body as YouTubeCaptureRequest;

    if (!body.client || !body.youtube) {
      return res.status(400).json({
        status: 'failed',
        recordId: null,
        error: { stage: 'transcript', message: 'Invalid request: missing client or youtube data' },
      } satisfies YouTubeCaptureResponse);
    }

    const { video_id, video_url, captured_at } = body.youtube;
    const { device_id } = body.client;

    if (!video_id || !video_url) {
      return res.status(400).json({
        status: 'failed',
        recordId: null,
        error: { stage: 'transcript', message: 'Invalid request: missing video_id or video_url' },
      } satisfies YouTubeCaptureResponse);
    }

    // Check for duplicate video_id
    const db = getDb();
    const existingCapture = db
      .prepare('SELECT id FROM youtube_captures WHERE video_id = ?')
      .get(video_id) as { id: string } | undefined;

    if (existingCapture) {
      return res.json({
        status: 'completed',
        recordId: existingCapture.id,
      } satisfies YouTubeCaptureResponse);
    }

    // Stage 1: Fetch transcript
    let transcriptResult;
    const transcriptStart = Date.now();
    try {
      const provider = getTranscriptProvider();
      transcriptResult = await provider.fetchTranscript(video_id);

      executionLog.stages.push({
        stage: 'transcript',
        durationMs: Date.now() - transcriptStart,
        success: true,
      });
    } catch (error) {
      executionLog.stages.push({
        stage: 'transcript',
        durationMs: Date.now() - transcriptStart,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.json({
        status: 'failed',
        recordId: null,
        error: {
          stage: 'transcript',
          message: error instanceof Error ? error.message : 'Failed to fetch transcript',
        },
      } satisfies YouTubeCaptureResponse);
    }

    // Stage 2: Fetch metadata
    let metadata;
    const metadataStart = Date.now();
    try {
      metadata = await fetchYouTubeMetadata(video_id);

      executionLog.stages.push({
        stage: 'metadata',
        durationMs: Date.now() - metadataStart,
        success: true,
      });
    } catch (error) {
      executionLog.stages.push({
        stage: 'metadata',
        durationMs: Date.now() - metadataStart,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.json({
        status: 'failed',
        recordId: null,
        error: {
          stage: 'metadata',
          message: error instanceof Error ? error.message : 'Failed to fetch metadata',
        },
      } satisfies YouTubeCaptureResponse);
    }

    // Stage 3: Generate LLM summary
    let summary;
    const llmStart = Date.now();
    try {
      const prompt = getYouTubeSummaryPrompt();

      // Prepare input for LLM
      const llmInput = JSON.stringify({
        title: metadata.title,
        channel: metadata.channel,
        transcript: transcriptResult.fullText.substring(0, 15000), // Limit to ~15k chars
      });

      // Call LLM with prompt template filled
      const filledPrompt = prompt
        .replace('{{title}}', metadata.title)
        .replace('{{channel}}', metadata.channel)
        .replace('{{transcript}}', transcriptResult.fullText.substring(0, 15000));

      summary = await callLLM(filledPrompt, llmInput);

      // Clean up the summary (remove any accidental JSON formatting)
      summary = summary.trim();
      if (summary.startsWith('"') && summary.endsWith('"')) {
        summary = summary.slice(1, -1);
      }

      executionLog.stages.push({
        stage: 'llm',
        durationMs: Date.now() - llmStart,
        success: true,
      });
    } catch (error) {
      executionLog.stages.push({
        stage: 'llm',
        durationMs: Date.now() - llmStart,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.json({
        status: 'failed',
        recordId: null,
        error: {
          stage: 'llm',
          message: error instanceof Error ? error.message : 'Failed to generate summary',
        },
      } satisfies YouTubeCaptureResponse);
    }

    // Stage 4: Store in database
    const dbStart = Date.now();
    try {
      executionLog.totalDurationMs = Date.now() - startTime;

      const insertStmt = db.prepare(`
        INSERT INTO youtube_captures (
          id, video_id, video_url,
          title, channel, published_at, duration_seconds,
          transcript_text, transcript_provider, summary,
          execution_json, status,
          client_device_id, created_at
        ) VALUES (
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?
        )
      `);

      insertStmt.run(
        recordId,
        video_id,
        video_url,
        metadata.title,
        metadata.channel,
        metadata.published_at,
        metadata.duration_seconds,
        transcriptResult.fullText,
        getTranscriptProvider().name,
        summary,
        JSON.stringify(executionLog),
        'completed',
        device_id,
        captured_at
      );

      executionLog.stages.push({
        stage: 'db',
        durationMs: Date.now() - dbStart,
        success: true,
      });

      console.log(`✅ YouTube capture stored: ${recordId} - "${metadata.title}"`);
    } catch (error) {
      executionLog.stages.push({
        stage: 'db',
        durationMs: Date.now() - dbStart,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return res.json({
        status: 'failed',
        recordId: null,
        error: {
          stage: 'db',
          message: error instanceof Error ? error.message : 'Failed to store in database',
        },
      } satisfies YouTubeCaptureResponse);
    }

    // Success!
    return res.json({
      status: 'completed',
      recordId,
    } satisfies YouTubeCaptureResponse);
  } catch (error) {
    console.error('Unexpected error in POST /youtube/capture:', error);
    return res.status(500).json({
      status: 'failed',
      recordId: null,
      error: {
        stage: 'transcript',
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    } satisfies YouTubeCaptureResponse);
  }
});
