# YouTube AI Video Summary — Implementation Plan

## Purpose

Add a second, independent option to the Chrome extension's YouTube popup flow: an
on-demand, flexible-prompt video summary (Glasp-style — transcript + a prompt sent
to an LLM, text back immediately), rendered as a formatted page in a new tab.

This is an **entertainment/personal-productivity feature**, deliberately decoupled
from the cortex knowledge base. It does not write to `youtube_captures`, does not
appear in `/recent`, and does not interact with the capture/classification/review
pipeline in any way. It is a sibling feature to the existing "Capture YouTube
Summary" button, not an extension of it.

## Non-goals

- No persistence of summaries (ephemeral — proof of concept). If history is wanted
  later, that's a separate follow-up decision.
- No changes to `apps/youtube-briefing` (channel monitoring, relevance scoring,
  digest email). That app's architecture, DB, and jobs are untouched.
- No changes to `packages/core` (transcript provider, LLM client, embeddings) —
  consumed as-is.
- No structured/grounded-evidence output (no timestamped citation mechanism like
  `youtube-briefing`'s digest generator). Plain-text/simple-markdown LLM output is
  sufficient for this feature.
- No new authentication system for the backend. This backend has no auth on any
  route today; adding one for this feature alone would be inconsistent with the
  rest of the codebase and out of scope. The abuse risk this feature specifically
  introduces (paid LLM calls, not just reads) is addressed with cost/rate controls
  instead — see **Security & abuse controls** below.

## Existing building blocks being reused

| Piece | Source | Reused as-is? |
|---|---|---|
| YouTube video-page detection (`extractVideoId`, active-tab query) | `apps/extension/src/popup/CaptureScreen.tsx` | Yes |
| Transcript fetch | `packages/core` `createYouTubeTranscriptProvider()` via `apps/backend/src/youtube/transcriptProvider.ts` | Yes |
| Metadata fetch (title/channel) | `apps/backend/src/youtube/metadataFetcher.ts` (`fetchYouTubeMetadata`) | Yes |
| LLM call abstraction | `packages/core/src/llm` (`createOpenAIClient`, `LLMClient.call()`) | Yes — used instead of backend's bespoke `callLLM`/`llmClient.ts`, matching the pattern `youtube-briefing` already uses. See **LLM response normalization** below for why this route does its own type-narrowing on `raw` rather than reusing backend's silent-stringify fallback. |
| Extension↔background↔backend messaging pattern | `apps/extension/src/lib/messaging.ts`, `background/index.ts` | Pattern reused, new message type added |
| Transcript length fallback (truncate to a char budget) | `apps/backend/src/routes/youtube.ts` (`.substring(0, 15000)`) | Reused for MVP; `youtube-briefing`'s chunked overflow-extraction is available later if needed |

## Dependencies & configuration

No new services or packages are introduced. Required backend environment
variables (all already used by the existing capture route, none new):

- `OPENAI_API_KEY` — required, backend-side only. Never sent to or stored in the
  extension.
- `OPENAI_MODEL` — optional, defaults to `gpt-4o-mini`, same as the existing
  route.
- `YOUTUBE_API_KEY` — required for the metadata-fetch stage, same as the
  existing capture route.

No extension-side secrets of any kind. The extension only ever holds
`apiBaseUrl` (already stored) and the user's own prompt text.

## Data flow

```
Popup (CaptureScreen)
  → user on youtube.com/watch, clicks "AI Video Summary"
  → picks preset (TL;DR / Deep Dive) or edits prompt freely
  → "Summarize" button disables itself immediately (in-flight guard, see Idempotency)
  → sendToBackground("SUMMARIZE_YOUTUBE", { video_url, video_id, prompt })
       ↓
Background service worker
  → POST {apiBaseUrl}/youtube/summarize
      { client: ClientMeta, youtube: { video_url, video_id, prompt } }
       ↓
Backend: apps/backend/src/routes/youtubeSummary.ts
  → validate client + youtube envelope, prompt non-empty and within length cap
  → rate-limit check (per device_id + IP, see Security section) — 429 if exceeded
  → fetchTranscript(video_id)        [packages/core, reused]
  → fetchYouTubeMetadata(video_id)   [existing helper, reused]
  → build input = prompt + title/channel + transcript (truncated to budget)
  → LLMClient.call({ role: 'summarizer', prompt, input }, { signal: <timeout> })
  → normalize result.raw (must be a string — see LLM response normalization)
  → return { status, summary, title, channel, video_id } — no DB write
       ↓
Background service worker
  → re-enables the "Summarize" button / clears in-flight state
  → generates a request id (crypto.randomUUID())
  → await chrome.storage.session.set({ [id]: result })   (must complete before next line)
  → chrome.tabs.create({ url: chrome.runtime.getURL(`summary.html?id=${id}`) })
       ↓
New tab: apps/extension summary.html / Summary.tsx
  → reads result from chrome.storage.session by id
  → immediately removes that key (read-once — prevents accumulation across a session)
  → if id missing/absent: renders a clear "no longer available" empty state
  → renders title (linked to https://www.youtube.com/watch?v={video_id}), channel,
    and the formatted summary body
```

## Extension changes (`apps/extension`)

1. **`popup/CaptureScreen.tsx`**: add a second button, "AI Video Summary", shown
   under the same `isYouTubePage && videoInfo` condition as the existing capture
   button. Clicking it transitions to a new lightweight prompt-editing view
   (either a new screen component or an inline expanded section within
   `CaptureScreen`).

2. **New prompt-editing UI**:
   - Two preset chips: **TL;DR** and **Deep Dive**.
   - Selecting a preset pre-fills an editable `<textarea>` — never sends
     immediately, since the user tailors the prompt per video.
   - "Deep Dive" splices the saved Project Context (see below) into its template
     before pre-filling, so the user edits a complete draft rather than
     assembling it by hand each time.
   - A "Summarize" button triggers the send. **On click it immediately disables
     and shows a loading state** until the background responds with success or
     failure — this is the in-flight guard described under Idempotency; it is
     not re-enabled by a second click while a request is outstanding.

3. **`options/Options.tsx`**: new persistent field, "Project Context" — a
   freeform textarea (e.g. holds the marketplace business description) saved to
   `chrome.storage`. Used only by the Deep Dive preset; irrelevant to TL;DR.

4. **`lib/storage.ts`**: new `StorageSchema` key, e.g.:
   ```ts
   summaryContext: string; // freeform project/context paragraph, used by "Deep Dive" preset
   ```
   Default: empty string.

5. **`lib/messaging.ts`**: new message type:
   ```ts
   SUMMARIZE_YOUTUBE: {
     request: { video_url: string; video_id: string; prompt: string };
     response: {
       status: 'completed' | 'failed';
       summary?: string;
       title?: string;
       channel?: string;
       video_id?: string;
       error?: { stage: 'transcript' | 'metadata' | 'llm' | 'validation' | 'rate_limit'; message: string };
     };
   };
   ```

6. **`background/index.ts`**: new handler for `SUMMARIZE_YOUTUBE`:
   - POSTs to `{apiBaseUrl}/youtube/summarize` with the `client` envelope
     (`clientMeta` from storage, same pattern as `CAPTURE_YOUTUBE`) plus the
     `youtube` payload.
   - On success, generates a request id (`crypto.randomUUID()`), **awaits**
     `chrome.storage.session.set({ [id]: response })` before calling
     `chrome.tabs.create({ url: chrome.runtime.getURL('summary.html?id=' + id) })`.
     `chrome.storage.session` is used (not `local`) so results clear when the
     browser session ends, matching "ephemeral." No extra manifest permission is
     needed — `chrome.storage.session` is covered by the existing `"storage"`
     permission (Chrome 102+), and `chrome.tabs.create` needs no `"tabs"`
     permission for this usage (that permission only gates reading other tabs'
     URLs/titles, not creating a new tab to an extension-owned page).
   - Returns the response to the popup so the "Summarize" button can clear its
     in-flight state regardless of success/failure.

7. **New Vite entry point**: `apps/extension/src/summary/` (`summary.html`,
   `Summary.tsx`), registered alongside the existing `popup`/`options` entries in
   `vite.config.ts`'s `build.rollupOptions.input`. On load:
   - Reads `?id=` from the URL.
   - Calls `chrome.storage.session.get(id)`; if present, renders the result, then
     immediately calls `chrome.storage.session.remove(id)` (read-once — this is
     the primary cleanup mechanism, so no TTL/alarm-based sweep is needed for the
     normal path; the only residual case is a tab that never finishes loading,
     which is an accepted, low-impact MVP limitation given entries are cleared on
     browser-session end regardless).
   - If the id is missing (already read, evicted, or the write raced — see
     Hand-off lifecycle below), renders a deterministic empty state: "This
     summary is no longer available. Results aren't saved — generate a new one
     from the video page."
   - Renders: video title linked to `https://www.youtube.com/watch?v={video_id}`,
     channel name, and the summary body (paragraph-formatted).

8. **`manifest.json`**: no changes required. Confirmed against the current file
   (`permissions: ["storage","activeTab","scripting","contextMenus"]`,
   `web_accessible_resources: [{resources:["public/*"], matches:["<all_urls>"]}]`):
   `summary.html` is opened via `chrome.runtime.getURL()` from the extension's
   own background script, not injected or referenced by a content script or an
   external page, so it does **not** need a `web_accessible_resources` entry.
   This is a concrete implementation check, not an open question.

## Storage-session hand-off lifecycle (explicit)

This directly replaces the earlier vague description with concrete ordering and
failure handling:

1. Background generates a unique id (`crypto.randomUUID()`) after a successful
   backend response.
2. Background `await`s `chrome.storage.session.set({ [id]: result })` — the
   `await` is mandatory; `chrome.tabs.create` must not be called until the write
   promise resolves, to avoid a race where the new tab reads before the write
   lands.
3. Background calls `chrome.tabs.create({ url: ... })`.
4. `Summary.tsx`, on mount, reads the key, renders it, and calls
   `chrome.storage.session.remove(id)` immediately after a successful read
   (read-once semantics — prevents entries accumulating across a browsing
   session).
5. If the key is absent when `Summary.tsx` reads it (already consumed, evicted,
   or the tab was reloaded after the first read), render the empty/error state
   described above rather than a blank page.
6. No TTL sweep or `chrome.alarms`-based cleanup is added for MVP — the
   read-once removal handles the normal path, and worst case (a tab opened but
   never loaded) is bounded by the browser session lifetime of
   `chrome.storage.session` itself. This is a deliberate, documented scope
   decision, not an oversight.

## LLM response normalization

`packages/core`'s `LLMCallResult.raw` is typed `string | object` — the shared
type does not guarantee a plain string. The existing capture route sidesteps
this by calling backend's own `callLLM()` wrapper, which silently
`JSON.stringify`s non-string `raw` values; **this route must not do that**,
since an object payload here means something went wrong (the model didn't
return plain text), not that stringifying is an acceptable fallback for a
user-facing summary.

The route therefore does its own narrowing after calling
`packages/core`'s `LLMClient.call()` directly:

```ts
const result = await llmClient.call({ role: 'summarizer', prompt, input }, { signal });
if (typeof result.raw !== 'string' || result.raw.trim().length === 0) {
  return { status: 'failed', error: { stage: 'llm', message: 'unexpected non-text LLM response' } };
}
const summary = result.raw.trim(); // same quote-stripping as the existing capture route
```

## Security & abuse controls

This is the primary gap identified in review: `POST /youtube/summarize` forwards
arbitrary user-supplied prompt text to a paid LLM, which is a materially
different risk profile from the existing read-oriented endpoints. Controls,
scoped proportionately for a personal-use/local-dev backend (not a
multi-tenant production service):

- **Request envelope**: the route requires the same `client: ClientMeta` object
  every other extension-originated request sends (already defined in
  `packages/contracts`), validated for presence — this is validated exactly the
  same way `POST /youtube/capture` already validates it, so no new pattern is
  introduced.
- **Input caps**: `prompt` is capped at a fixed length (e.g. 4,000 characters) —
  rejected with a 400 if exceeded. Transcript truncation reuses the existing
  15,000-character budget from the capture route, unchanged.
- **Rate limiting**: a simple in-memory sliding-window limiter keyed on
  `client.device_id` (falling back to request IP), e.g. N requests per minute.
  This is process-local and resets on backend restart — an explicitly accepted
  MVP limitation given there is no database this feature is allowed to write to
  and no existing rate-limiting infrastructure anywhere else in the backend to
  extend. If this feature sees real usage beyond proof-of-concept, a persistent
  limiter is a natural follow-up, not a blocker now.
- **LLM call timeout**: an `AbortSignal` with a fixed deadline (e.g. 30s) is
  passed to `LLMClient.call()`, so a slow/hung model call can't hold the request
  (or a rate-limit slot) open indefinitely.
- **Trust model, stated explicitly**: like every other route in
  `apps/backend`, this endpoint has no bearer-token authentication — the backend
  is assumed to be a local/trusted-network dev server the user's own extension
  talks to (`apiBaseUrl` defaults to `localhost:3000`). Adding an auth system for
  this one route would be inconsistent with the rest of the codebase and out of
  scope; the caps and rate limiting above are the actual mitigation for this
  route's specific new risk (cost), not an attempt to fully secure the backend.

## Idempotency / duplicate-submission handling

The feature is ephemeral but not side-effect-free — every request triggers a
real transcript fetch and a paid LLM call. Mitigation, scoped to what's
proportionate for a single-user extension flow (not a distributed system):

- **UI-level in-flight guard** (primary mitigation): the "Summarize" button
  disables itself on click and stays disabled until the background responds,
  preventing double-submission from repeated clicks. There is no automatic
  retry anywhere in this flow, so the only realistic duplicate-trigger path is a
  manual double-click, which this guard directly prevents.
- **No server-side idempotency key** for MVP — given the ephemeral/no-DB scope,
  there's no persisted state to de-duplicate against. The rate limiter above
  provides a coarse backstop against repeated calls beyond the UI guard.

## Backend changes (`apps/backend`)

1. **New route file**: `apps/backend/src/routes/youtubeSummary.ts`, mounted at
   `POST /youtube/summarize`. Deliberately separate from `routes/youtube.ts` —
   no shared handler, no shared DB table, so the capture/ingestion path is
   untouched by this work.

2. **Testable structure**: the module exports a factory,
   `createYoutubeSummaryRouter(deps: { transcriptProvider, metadataFetcher, llmClient, now? })`,
   defaulting each dependency to the real implementation, rather than relying on
   module-level mutable singletons. This lets the route's tests inject fakes
   directly (see Verification plan) without the global-state pattern backend's
   own `llmClient.ts` uses for its own `callLLM` — appropriate here since this
   route intentionally does not go through that seam (see LLM response
   normalization above).

3. **Request validation**: require `client` (same shape as `/youtube/capture`),
   `video_url`, `video_id`, and a non-empty `prompt` within the length cap (400
   otherwise, `stage: 'validation'`).

4. **Rate limit check**: reject with 429 (`stage: 'rate_limit'`) before doing any
   transcript/metadata/LLM work if the caller has exceeded the configured
   window.

5. **Stage 1 — transcript**: reuse
   `getTranscriptProvider().fetchTranscript(video_id)` from
   `apps/backend/src/youtube/transcriptProvider.ts`. On failure, return
   `{status: 'failed', error: {stage: 'transcript', message}}`.

6. **Stage 2 — metadata**: reuse `fetchYouTubeMetadata(video_id)` from
   `apps/backend/src/youtube/metadataFetcher.ts` for `title`/`channel`. On
   failure, same error-stage pattern (`stage: 'metadata'`).

7. **Stage 3 — LLM call**: build the model input from the user's `prompt` plus
   title/channel context plus the transcript text, truncated to the 15,000-char
   budget. Call `packages/core`'s `createOpenAIClient(...).call(...)` with the
   timeout signal, then apply the normalization in **LLM response
   normalization** above. On failure, `stage: 'llm'`.

8. **Response**: `{status: 'completed', summary, title, channel, video_id}` — no
   DB interaction at all, per the ephemeral decision. `video_id` is echoed back
   from the request so the summary page can construct the video link without
   the background script needing to separately thread request data through to
   the stored result.

## Contracts (`packages/contracts/src/index.ts`)

```ts
export interface YouTubeSummarizeRequest {
  client: ClientMeta;
  youtube: { video_url: string; video_id: string; prompt: string };
}

export interface YouTubeSummarizeResponse {
  status: 'completed' | 'failed';
  summary?: string;
  title?: string;
  channel?: string;
  video_id?: string;
  error?: {
    stage: 'transcript' | 'metadata' | 'llm' | 'validation' | 'rate_limit';
    message: string;
  };
}
```

Mirrors the existing `YouTubeCaptureRequest`/`YouTubeCaptureResponse` shape for
consistency; not wired into `packages/sdk` for MVP (the background script talks
to the backend directly via `fetch`, matching how `CAPTURE_YOUTUBE` already
works).

## Prompt presets (initial content)

- **TL;DR**: short instruction for a concise, punchy summary of the video's main
  points — no context splicing.
- **Deep Dive**: instruction to summarize main points, break out subtopics, and
  explicitly connect concepts to the user's ongoing work — template includes a
  placeholder that's filled from the saved `summaryContext` field before being
  shown to the user for final editing.

Both presets are starting points, not fixed templates — the user edits before
every send, matching current manual usage.

## Verification plan (tests before code)

Per this plan's TDD requirement, tests are written first for each new unit of
behavior, then the implementation is written to satisfy them:

1. **Backend route tests** (`apps/backend/tests/youtubeSummary.test.ts`),
   written before `routes/youtubeSummary.ts`'s implementation, using
   `createYoutubeSummaryRouter(deps)` to inject fakes:
   - Success path: fake transcript/metadata/LLM client → `200` with
     `{status:'completed', summary, title, channel, video_id}`.
   - Transcript-stage failure → `{status:'failed', error:{stage:'transcript'}}`.
   - Metadata-stage failure → `{stage:'metadata'}`.
   - LLM-stage failure, including the non-string `raw` case specifically →
     `{stage:'llm'}`.
   - Validation failures: missing `prompt`, empty `prompt`, prompt over the
     length cap, missing `client` → 400 with `stage:'validation'`.
   - Rate-limit exceeded → 429 with `stage:'rate_limit'`.
2. **Extension-side coverage**: `apps/extension` currently has no test runner
   configured (only `dev`/`build`/`preview`/`lint`/`typecheck` scripts exist —
   confirmed against `apps/extension/package.json`; only backend/core/briefing
   have `npm test` equivalents). Adding a full test harness to the extension is
   out of scope for this feature. Given that, extension-side hand-off logic
   (storage-session write/read/remove ordering, missing-id empty state) is
   verified manually per the checklist below rather than by an automated test,
   and this scoping decision is stated explicitly rather than silently skipped.
   If the extension gains a test runner in the future, the storage-session
   hand-off and `Summary.tsx`'s missing-id state are the first things worth
   covering.
3. **Manual verification** (post-implementation): load the unpacked extension,
   open a YouTube video, use both presets on a short and a long video, confirm:
   - The new tab renders correctly and the video link works.
   - No rows appear in `youtube_captures` / `/recent`.
   - Double-clicking "Summarize" only sends one request.
   - Reloading the summary tab after it has already rendered once shows the
     "no longer available" state (proves read-once removal).
   - Hitting the rate limit surfaces a clear error in the popup.
4. **Checks before push**: `npm run typecheck`, `npm run lint`, and
   `npm test` (backend) for all affected packages/apps, plus
   `npm run build:extension` and a build of `apps/backend` to catch
   packaging/entry-point regressions from the new Vite entry point and route
   file — not just typecheck/lint as originally scoped.

## Delivery

- Branch: `feat/extension/ai-video-summary`, following this repo's actual
  convention (`feat/<app>/<slug>` merged via PR into `integration`, per existing
  git history — not `main`, and not a `work/<topic>/<desc>` convention).
- PR description covers: what this adds, why it's decoupled from cortex
  ingestion, the security/rate-limiting scope decisions above, and the
  verification checklist from this plan.
- Rollback: since there are no migrations or persisted schema changes, rollback
  is a plain code revert — either the extension-side change (removing the
  `SUMMARIZE_YOUTUBE` UI path) or the backend route mount can be reverted
  independently and in either order, since no existing client depends on
  `/youtube/summarize`.

## Future work (explicitly out of scope now)

- Chunked/overflow transcript handling for long videos, reusing
  `youtube-briefing`'s `chunkSegments`/`runOverflowExtraction` approach instead
  of flat truncation.
- Optional history/persistence if the ephemeral flow proves too throwaway in
  practice.
- Additional presets beyond TL;DR/Deep Dive.
- A persistent (cross-restart) rate limiter, if usage grows beyond
  proof-of-concept.
