/**
 * YouTube Channel Adapter
 * 
 * Fetches videos from YouTube channels using the Data API v3.
 * Uses uploads playlist approach for reliable video discovery.
 */

export interface ChannelInfo {
  channelId: string;
  channelName: string;
  uploadsPlaylistId: string;
}

export interface VideoInfo {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
}

interface YouTubeChannelResponse {
  items?: Array<{
    id: string;
    snippet: {
      title: string;
    };
    contentDetails: {
      relatedPlaylists: {
        uploads: string;
      };
    };
  }>;
}

interface YouTubePlaylistItemsResponse {
  items?: Array<{
    snippet: {
      resourceId: {
        videoId: string;
      };
      title: string;
      description: string;
      publishedAt: string;
      thumbnails?: {
        high?: { url: string };
        medium?: { url: string };
        default?: { url: string };
      };
    };
  }>;
  nextPageToken?: string;
}

interface YouTubeVideosResponse {
  items?: Array<{
    id: string;
    contentDetails: {
      duration: string;
    };
  }>;
}

function getApiKey(): string {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY environment variable is not set');
  }
  return apiKey;
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
 * Get channel info including uploads playlist ID
 */
export async function getChannelInfo(channelId: string): Promise<ChannelInfo> {
  const apiKey = getApiKey();
  
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', channelId);
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());
  
  if (!response.ok) {
    throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as YouTubeChannelResponse;
  
  if (!data.items || data.items.length === 0) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const channel = data.items[0];
  
  return {
    channelId: channel.id,
    channelName: channel.snippet.title,
    uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads,
  };
}

/**
 * Fetch videos from a channel's uploads playlist
 * 
 * @param uploadsPlaylistId - The uploads playlist ID for the channel
 * @param publishedAfter - Only return videos published after this ISO date
 * @param maxResults - Maximum videos to return (default 50)
 */
export async function getChannelVideos(
  uploadsPlaylistId: string,
  channelId: string,
  publishedAfter?: string,
  maxResults: number = 50
): Promise<VideoInfo[]> {
  const apiKey = getApiKey();
  const videos: VideoInfo[] = [];
  let pageToken: string | undefined;
  
  // Step 1: Get video IDs from playlist
  const videoIds: string[] = [];
  const videoSnippets = new Map<string, {
    title: string;
    description: string;
    publishedAt: string;
    thumbnailUrl: string | null;
  }>();

  while (videoIds.length < maxResults) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', uploadsPlaylistId);
    url.searchParams.set('maxResults', String(Math.min(50, maxResults - videoIds.length)));
    url.searchParams.set('key', apiKey);
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as YouTubePlaylistItemsResponse;
    
    if (!data.items || data.items.length === 0) {
      break;
    }

    for (const item of data.items) {
      const publishedAt = item.snippet.publishedAt;
      
      // Filter by publishedAfter if specified
      if (publishedAfter && publishedAt <= publishedAfter) {
        // Playlist is sorted by date desc, so we can stop here
        pageToken = undefined;
        break;
      }

      const videoId = item.snippet.resourceId.videoId;
      videoIds.push(videoId);
      videoSnippets.set(videoId, {
        title: item.snippet.title,
        description: item.snippet.description,
        publishedAt: item.snippet.publishedAt,
        thumbnailUrl: 
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.default?.url ||
          null,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  if (videoIds.length === 0) {
    return [];
  }

  // Step 2: Get video durations (batch request)
  const durationMap = new Map<string, number>();
  
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      console.warn(`Failed to fetch video details: ${response.status}`);
      continue;
    }

    const data = await response.json() as YouTubeVideosResponse;
    
    if (data.items) {
      for (const item of data.items) {
        durationMap.set(item.id, parseDuration(item.contentDetails.duration));
      }
    }
  }

  // Step 3: Combine into VideoInfo objects
  for (const videoId of videoIds) {
    const snippet = videoSnippets.get(videoId);
    if (!snippet) continue;

    videos.push({
      videoId,
      channelId,
      title: snippet.title,
      description: snippet.description,
      publishedAt: snippet.publishedAt,
      durationSeconds: durationMap.get(videoId) || 0,
      thumbnailUrl: snippet.thumbnailUrl,
    });
  }

  return videos;
}
