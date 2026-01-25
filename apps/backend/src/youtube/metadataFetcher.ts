/**
 * YouTube Metadata Fetcher
 *
 * Fetches video metadata from YouTube Data API v3.
 * Requires YOUTUBE_API_KEY environment variable.
 */

export interface YouTubeMetadata {
  title: string;
  channel: string;
  published_at: string;
  duration_seconds: number;
  description?: string;
  thumbnail_url?: string;
}

interface YouTubeAPIResponse {
  items: Array<{
    snippet: {
      title: string;
      channelTitle: string;
      publishedAt: string;
      description: string;
      thumbnails?: {
        default?: { url: string };
        medium?: { url: string };
        high?: { url: string };
      };
    };
    contentDetails: {
      duration: string; // ISO 8601 duration format, e.g., "PT4M13S"
    };
  }>;
}

/**
 * Parse ISO 8601 duration to seconds
 * Example: "PT4M13S" -> 253
 */
function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Fetch YouTube video metadata
 *
 * @param videoId - YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns Video metadata
 * @throws Error if API key not configured or video not found
 */
export async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeMetadata> {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY environment variable is not set');
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(
      `YouTube API error: ${response.status} - ${errorData.error?.message || response.statusText}`
    );
  }

  const data = await response.json() as YouTubeAPIResponse;

  if (!data.items || data.items.length === 0) {
    throw new Error('Video not found or is private');
  }

  const video = data.items[0];
  const snippet = video.snippet;
  const contentDetails = video.contentDetails;

  return {
    title: snippet.title,
    channel: snippet.channelTitle,
    published_at: snippet.publishedAt,
    duration_seconds: parseDuration(contentDetails.duration),
    description: snippet.description,
    thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
  };
}
