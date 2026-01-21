/**
 * @secondbrain/sdk
 *
 * Typed SDK for Second Brain OS API.
 * Use this package to interact with the backend from:
 * - apps/extension (Chrome extension)
 * - apps/experiments (safe vibe-coding lane)
 *
 * All functions are type-safe and match the OpenAPI spec.
 */

import type {
  ClientMeta,
  CaptureContext,
  CaptureRequest,
  CaptureResponse,
  FixRequest,
  FixResponse,
  CanonicalRecord,
  RecentResponse,
  DigestPreviewRequest,
  DigestPreviewResponse,
  ReviewPreviewRequest,
  ReviewPreviewResponse,
} from '@secondbrain/contracts';

// Re-export commonly used types
export type {
  ClientMeta,
  CaptureContext,
  CaptureResponse,
  FixResponse,
  CanonicalRecord,
  RecentResponse,
} from '@secondbrain/contracts';

/**
 * SDK Configuration
 */
export interface SDKConfig {
  baseUrl: string;
  /** Optional fetch implementation (useful for testing) */
  fetch?: typeof fetch;
}

/**
 * SDK Error
 */
export class SecondBrainError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = 'SecondBrainError';
  }
}

/**
 * Create a Second Brain SDK client
 */
export function createClient(config: SDKConfig) {
  const { baseUrl, fetch: customFetch = fetch } = config;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await customFetch(url, options);

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new SecondBrainError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    return response.json() as Promise<T>;
  }

  return {
    /**
     * Capture a thought, classify, and file (or return needs_review)
     */
    async capture(params: {
      client: ClientMeta;
      raw_text: string;
      captured_at: string;
      context: CaptureContext;
    }): Promise<CaptureResponse> {
      const body: CaptureRequest = {
        client: params.client,
        capture: {
          raw_text: params.raw_text,
          captured_at: params.captured_at,
          context: params.context,
        },
      };
      return request<CaptureResponse>('POST', '/capture', body);
    },

    /**
     * Apply a user correction to an existing record or needs_review item
     */
    async fix(params: {
      client: ClientMeta;
      capture_id: string;
      inbox_log_id: string;
      record_id: string | null;
      user_correction: string;
      existing_record: CanonicalRecord;
    }): Promise<FixResponse> {
      const body: FixRequest = {
        client: params.client,
        fix: {
          capture_id: params.capture_id,
          inbox_log_id: params.inbox_log_id,
          record_id: params.record_id,
          user_correction: params.user_correction,
          existing_record: params.existing_record,
        },
      };
      return request<FixResponse>('POST', '/fix', body);
    },

    /**
     * Get recent captures for the extension log view
     */
    async recent(params: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<RecentResponse> {
      const searchParams = new URLSearchParams();
      if (params.limit !== undefined) {
        searchParams.set('limit', String(params.limit));
      }
      if (params.cursor !== undefined) {
        searchParams.set('cursor', params.cursor);
      }
      const query = searchParams.toString();
      const path = query ? `/recent?${query}` : '/recent';
      return request<RecentResponse>('GET', path);
    },

    /**
     * Generate a preview of the daily digest
     */
    async digestPreview(
      body: DigestPreviewRequest
    ): Promise<DigestPreviewResponse> {
      return request<DigestPreviewResponse>('POST', '/digest/preview', body);
    },

    /**
     * Generate a preview of the weekly review
     */
    async reviewPreview(
      body: ReviewPreviewRequest
    ): Promise<ReviewPreviewResponse> {
      return request<ReviewPreviewResponse>('POST', '/review/preview', body);
    },
  };
}

/**
 * SDK Client type
 */
export type SecondBrainClient = ReturnType<typeof createClient>;
