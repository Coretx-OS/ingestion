import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache prompts in memory after first load
const promptCache: Record<string, string> = {};

/**
 * Load a prompt from backend/src/prompts/*.txt
 *
 * Prompts are treated as versioned APIs - their I/O is stable and deterministic.
 *
 * @param promptName - Name of prompt file (without .txt extension)
 * @returns Prompt text
 */
export function loadPrompt(promptName: string): string {
  // Return cached version if available
  if (promptCache[promptName]) {
    return promptCache[promptName];
  }

  // Load from file
  const promptPath = join(__dirname, '..', '..', 'src', 'prompts', `${promptName}.txt`);

  try {
    const promptText = readFileSync(promptPath, 'utf-8').trim();

    if (!promptText) {
      throw new Error(`Prompt file is empty: ${promptName}.txt`);
    }

    // Cache for future use
    promptCache[promptName] = promptText;

    console.log(`✅ Loaded prompt: ${promptName}.txt`);
    return promptText;
  } catch (error) {
    throw new Error(
      `Failed to load prompt '${promptName}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the classifier prompt (for POST /capture)
 */
export function getClassifierPrompt(): string {
  return loadPrompt('classifier');
}

/**
 * Get the fix prompt (for POST /fix)
 */
export function getFixPrompt(): string {
  return loadPrompt('fix');
}

/**
 * Get the digest prompt (for POST /digest/preview)
 */
export function getDigestPrompt(): string {
  return loadPrompt('digest');
}

/**
 * Get the review prompt (for POST /review/preview)
 */
export function getReviewPrompt(): string {
  return loadPrompt('review');
}

/**
 * Get the YouTube summary prompt (for POST /youtube/capture)
 */
export function getYouTubeSummaryPrompt(): string {
  return loadPrompt('youtube-summary');
}

/**
 * Preload all prompts at startup (optional, for faster first requests)
 */
export function preloadAllPrompts(): void {
  getClassifierPrompt();
  getFixPrompt();
  getDigestPrompt();
  getReviewPrompt();
  getYouTubeSummaryPrompt();
  console.log('✅ All prompts preloaded');
}
