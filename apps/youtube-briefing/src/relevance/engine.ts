/**
 * Relevance Engine
 * 
 * Scores videos based on:
 * 1. Relevance: similarity to user profile interests
 * 2. Novelty: dissimilarity to known concepts in knowledge base
 * 
 * Uses OpenAI embeddings via @secondbrain/core
 */

import { randomUUID } from 'crypto';
import { 
  createOpenAIEmbeddings, 
  cosineSimilarity,
  type EmbeddingsProvider 
} from '@secondbrain/core';
import { getDb } from '../db/connection.js';

export interface ScoredVideo {
  videoId: string;
  title: string;
  relevanceScore: number;
  noveltyScore: number;
  combinedScore: number;
  reasoning: string;
}

export interface UserProfile {
  id: string;
  name: string;
  interests: string[];
  projects: string[];
  strategyThemes: string[];
}

interface ProfileRow {
  id: string;
  name: string;
  interests: string;
  projects: string;
  strategy_themes: string;
  interest_embedding: string | null;
  embedding_model: string | null;
}

interface VideoRow {
  id: string;
  video_id: string;
  title: string;
  description: string | null;
}

interface EmbeddingRow {
  video_id: string;
  content_embedding: string;
}

interface KnowledgeRow {
  concept_embedding: string;
}

interface ScoreRow {
  video_id: string;
  relevance_score: number;
  novelty_score: number;
  combined_score: number;
}

let embeddingsProvider: EmbeddingsProvider | null = null;

function getEmbeddings(): EmbeddingsProvider {
  if (embeddingsProvider) return embeddingsProvider;
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for embeddings');
  }
  
  embeddingsProvider = createOpenAIEmbeddings({
    apiKey,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  });
  
  return embeddingsProvider;
}

/**
 * Create or update a user profile
 */
export async function upsertProfile(profile: UserProfile): Promise<void> {
  const db = getDb();
  const embeddings = getEmbeddings();
  
  // Create combined text for embedding
  const combinedText = [
    ...profile.interests,
    ...profile.projects,
    ...profile.strategyThemes,
  ].join('. ');
  
  // Generate embedding
  const result = await embeddings.embed(combinedText);
  
  // Upsert profile
  db.prepare(`
    INSERT INTO user_profiles (id, name, interests, projects, strategy_themes, 
                               interest_embedding, embedding_model, embedding_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      interests = excluded.interests,
      projects = excluded.projects,
      strategy_themes = excluded.strategy_themes,
      interest_embedding = excluded.interest_embedding,
      embedding_model = excluded.embedding_model,
      embedding_updated_at = datetime('now'),
      updated_at = datetime('now')
  `).run(
    profile.id,
    profile.name,
    JSON.stringify(profile.interests),
    JSON.stringify(profile.projects),
    JSON.stringify(profile.strategyThemes),
    JSON.stringify(result.embedding),
    result.model
  );
}

/**
 * Get active user profiles
 */
export function getActiveProfiles(): UserProfile[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, interests, projects, strategy_themes
    FROM user_profiles
    WHERE is_active = 1
  `).all() as ProfileRow[];
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    interests: JSON.parse(row.interests) as string[],
    projects: JSON.parse(row.projects) as string[],
    strategyThemes: JSON.parse(row.strategy_themes) as string[],
  }));
}

/**
 * Ensure video has embedding cached
 */
async function ensureVideoEmbedding(videoId: string, title: string, description: string): Promise<number[]> {
  const db = getDb();
  
  // Check cache
  const cached = db.prepare(
    'SELECT content_embedding FROM video_embeddings WHERE video_id = ?'
  ).get(videoId) as EmbeddingRow | undefined;
  
  if (cached) {
    return JSON.parse(cached.content_embedding) as number[];
  }
  
  // Generate embedding
  const embeddings = getEmbeddings();
  const text = `${title}. ${description || ''}`.substring(0, 8000);
  const result = await embeddings.embed(text);
  
  // Cache
  db.prepare(`
    INSERT INTO video_embeddings (id, video_id, content_embedding, embedding_model)
    VALUES (?, ?, ?, ?)
  `).run(randomUUID(), videoId, JSON.stringify(result.embedding), result.model);
  
  return result.embedding;
}

/**
 * Calculate relevance score: similarity between video and profile
 */
async function calculateRelevance(
  videoEmbedding: number[],
  profileId: string
): Promise<number> {
  const db = getDb();
  
  const profile = db.prepare(
    'SELECT interest_embedding FROM user_profiles WHERE id = ?'
  ).get(profileId) as { interest_embedding: string | null } | undefined;
  
  if (!profile?.interest_embedding) {
    return 0.5; // Default if no profile embedding
  }
  
  const profileEmbedding = JSON.parse(profile.interest_embedding) as number[];
  const similarity = cosineSimilarity(videoEmbedding, profileEmbedding);
  
  // Normalize to 0-1 range (cosine similarity is -1 to 1)
  return (similarity + 1) / 2;
}

/**
 * Calculate novelty score: how different from known concepts
 */
async function calculateNovelty(videoEmbedding: number[]): Promise<number> {
  const db = getDb();
  
  const knownConcepts = db.prepare(
    'SELECT concept_embedding FROM knowledge_base'
  ).all() as KnowledgeRow[];
  
  if (knownConcepts.length === 0) {
    return 1.0; // Everything is novel if knowledge base is empty
  }
  
  // Find max similarity to any known concept
  let maxSimilarity = 0;
  for (const row of knownConcepts) {
    const conceptEmbedding = JSON.parse(row.concept_embedding) as number[];
    const similarity = cosineSimilarity(videoEmbedding, conceptEmbedding);
    maxSimilarity = Math.max(maxSimilarity, similarity);
  }
  
  // Novelty is inverse of similarity (more similar = less novel)
  // Normalize from -1..1 to 0..1, then invert
  const normalizedSimilarity = (maxSimilarity + 1) / 2;
  return 1 - normalizedSimilarity;
}

/**
 * Score a batch of videos for a profile
 */
export async function scoreVideos(
  profileId: string,
  videoIds?: string[]
): Promise<ScoredVideo[]> {
  const db = getDb();
  
  // Get videos to score
  let query = `
    SELECT v.id, v.video_id, v.title, v.description
    FROM videos v
    WHERE v.status = 'new'
  `;
  
  if (videoIds && videoIds.length > 0) {
    query += ` AND v.video_id IN (${videoIds.map(() => '?').join(',')})`;
  }
  
  const videos = db.prepare(query).all(...(videoIds || [])) as VideoRow[];
  
  const results: ScoredVideo[] = [];
  
  for (const video of videos) {
    // Check if already scored
    const existing = db.prepare(
      'SELECT relevance_score, novelty_score, combined_score FROM video_scores WHERE video_id = ? AND profile_id = ?'
    ).get(video.video_id, profileId) as ScoreRow | undefined;
    
    if (existing) {
      results.push({
        videoId: video.video_id,
        title: video.title,
        relevanceScore: existing.relevance_score,
        noveltyScore: existing.novelty_score,
        combinedScore: existing.combined_score,
        reasoning: 'cached',
      });
      continue;
    }
    
    // Generate embedding and scores
    const videoEmbedding = await ensureVideoEmbedding(
      video.video_id,
      video.title,
      video.description || ''
    );
    
    const relevanceScore = await calculateRelevance(videoEmbedding, profileId);
    const noveltyScore = await calculateNovelty(videoEmbedding);
    
    // Combined score: weighted average (relevance more important)
    const combinedScore = relevanceScore * 0.6 + noveltyScore * 0.4;
    
    const reasoning = `Relevance: ${(relevanceScore * 100).toFixed(1)}% (profile match). Novelty: ${(noveltyScore * 100).toFixed(1)}% (vs knowledge base).`;
    
    // Store score
    db.prepare(`
      INSERT INTO video_scores (id, video_id, profile_id, relevance_score, novelty_score, combined_score, score_reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), video.video_id, profileId, relevanceScore, noveltyScore, combinedScore, reasoning);
    
    results.push({
      videoId: video.video_id,
      title: video.title,
      relevanceScore,
      noveltyScore,
      combinedScore,
      reasoning,
    });
  }
  
  // Sort by combined score descending
  return results.sort((a, b) => b.combinedScore - a.combinedScore);
}

/**
 * Get top scored videos for a profile
 */
export function getTopVideos(profileId: string, limit: number = 10): ScoredVideo[] {
  const db = getDb();
  
  const rows = db.prepare(`
    SELECT vs.video_id, v.title, vs.relevance_score, vs.novelty_score, 
           vs.combined_score, vs.score_reasoning
    FROM video_scores vs
    JOIN videos v ON v.video_id = vs.video_id
    WHERE vs.profile_id = ?
    ORDER BY vs.combined_score DESC
    LIMIT ?
  `).all(profileId, limit) as Array<{
    video_id: string;
    title: string;
    relevance_score: number;
    novelty_score: number;
    combined_score: number;
    score_reasoning: string | null;
  }>;
  
  return rows.map(row => ({
    videoId: row.video_id,
    title: row.title,
    relevanceScore: row.relevance_score,
    noveltyScore: row.novelty_score,
    combinedScore: row.combined_score,
    reasoning: row.score_reasoning || '',
  }));
}

/**
 * Add a concept to the knowledge base
 */
export async function addKnowledge(concept: string, source?: string, sourceId?: string): Promise<void> {
  const db = getDb();
  const embeddings = getEmbeddings();
  
  const result = await embeddings.embed(concept);
  
  db.prepare(`
    INSERT INTO knowledge_base (id, concept, source, source_id, concept_embedding, embedding_model)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), concept, source || null, sourceId || null, JSON.stringify(result.embedding), result.model);
}

/**
 * Import knowledge from processed videos
 */
export async function importVideoToKnowledge(videoId: string): Promise<void> {
  const db = getDb();
  
  const video = db.prepare(
    'SELECT title, description FROM videos WHERE video_id = ?'
  ).get(videoId) as { title: string; description: string | null } | undefined;
  
  if (!video) return;
  
  // Add title as a concept
  await addKnowledge(video.title, 'video', videoId);
}
