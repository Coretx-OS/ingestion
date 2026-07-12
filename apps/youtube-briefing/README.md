# YouTube Daily Briefing

Automated YouTube channel monitoring, relevance scoring, and **transcript-grounded** strategic digests. Every digest bullet and "Watch key moment" link is derived from validated, timestamped transcript evidence - never an inferred or model-invented timestamp.

## Transcript grounding

- The transcript provider is owned by `@secondbrain/core` (`createYouTubeTranscriptProvider`), pinned to an exact `youtube-transcript` version, and shared with `apps/backend`.
- Transcripts are cached in the `video_transcripts` SQLite table, keyed by video ID and a **policy key** (provider version + ordered languages + language-fallback setting + segment schema version). Changing any of those invalidates prior cached outcomes for videos under the new policy.
- **Cache statuses:**
  - `available` - a validated transcript is cached; used directly without calling the provider again.
  - `unavailable` - currently unavailable *under the recorded policy* (captions disabled, video unavailable, or exhausted configured languages). Not permanently unavailable forever: rechecked after `BUDGET_UNAVAILABLE_RECHECK_DAYS` (default 30 days), or immediately on a policy change.
  - `retryable_failure` - a transient failure (timeout, throttling, transport error, unrecognized caption format). Retried on a backoff schedule (15m, 2h, 12h, 24h, then daily), and remains eligible for `BUDGET_RETRY_HORIZON_DAYS` (default 7 days) beyond the normal 24h freshness window that otherwise bounds candidate selection.
- Metadata relevance/novelty scoring (unchanged 60/40 formula) always runs before transcript retrieval. Only a bounded, ranked pool of candidates (`BUDGET_RANKED_CANDIDATE_ROWS`, default 30) is considered for transcript enrichment per profile per run, and only `BUDGET_LIVE_PROVIDER_ATTEMPTS` (default 20) live provider calls are made per run - cache hits don't count against that budget.
- Transcripts that fit the final digest prompt budget are sent to the LLM directly, with the model choosing a bounded start/end segment range per video. Transcripts that don't fit go through bounded, profile-aware **overflow evidence extraction** first (chunked calls, each returning a few candidate evidence spans), and the final call selects among that pre-validated evidence. See `src/config/budgets.ts` for every budget default and its `BUDGET_*` environment override.
- In both modes, the model may only reference segment IDs or evidence IDs that application code already assigned from the real transcript - it can never invent a timestamp, title, or channel name. All of that is validated and reconstructed by application code before a bullet can be persisted.
- **Overflow completeness is strict, not best-effort:** if even one chunk of a video's transcript is skipped by the per-profile call budget (`BUDGET_OVERFLOW_EVIDENCE_CALLS_PER_PROFILE`, default 6), skipped because the deadline passed, or fails/aborts outright, that whole video is excluded from this run's evidence pool (`deferred`) rather than partially represented - a truncated tail could have held the most relevant moment. **Operational consequence:** a video whose transcript chunks into more pieces than that budget allows will *never* produce a bullet under the current budgets, run after run, until `BUDGET_OVERFLOW_EVIDENCE_CALLS_PER_PROFILE` and/or `BUDGET_OVERFLOW_CHUNK_CHARS` are raised enough for it to fit. This is a budget-tuning decision, not a bug to route around in code.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TRANSCRIPT_LANGUAGES` | *(unset - use the provider's default track)* | Ordered, comma-separated caption language preference, e.g. `en,en-US`. When set, only those languages are tried; when unset, the provider accepts whatever caption track it's given and language-agnostic fallback is implicitly allowed. |
| `BUDGET_*` | see `src/config/budgets.ts` | Overrides for every candidate/provider/retry/LLM budget described above. |
| `OPENAI_API_KEY` | *(required)* | Used for relevance-scoring embeddings and digest/evidence-extraction LLM calls. |
| `YOUTUBE_API_KEY` | *(required)* | Used only for channel discovery and video **metadata** (title, description, duration, publish date) via the YouTube Data API. It is **not** used for transcript retrieval - captions are fetched through the unofficial `youtube-transcript` provider, since the official `captions.download` endpoint requires OAuth and edit permission on the video and cannot be used for arbitrary third-party videos. |
| `BRIEFING_DB_PATH` | `apps/youtube-briefing/data/briefing.db` | SQLite database path. Automated tests and the CLI preview harness below always require an explicit temporary path and refuse this default. |

### Provider limitations and failure expectations

`youtube-transcript` is an unofficial package that scrapes YouTube's InnerTube API and web player response - it can break when YouTube changes those internals. Expect:
- Occasional widespread retryable failures if YouTube changes its response shape. The provider fails closed (throws a retryable, typed error) rather than guessing at caption timing units from an unrecognized format.
- No live YouTube calls in automated tests - all provider/cache/pipeline tests run against fixture-backed fetch mocks and temporary databases.
- If the provider begins returning widespread empty or invalid responses in production, the system generates no bullets for affected videos rather than falling back to metadata-only, model-invented timestamps.

**Python/Hermes is not a runtime dependency.** A local Hermes skill (`~/.hermes/hermes-agent/skills/media/youtube-content/SKILL.md`) using Python's `youtube-transcript-api` was used only as a *behavior reference* while building this Node provider (validation rules, language-fallback behavior, long-transcript handling). It is not imported, shelled out to, or required at runtime. Revisit adding a second (e.g. Python-backed) provider only if measured Node-provider failure rates in production actually justify the added complexity of a subprocess/provider-registry abstraction.

## CLI preview harness

`dry_run=true` on `/jobs/daily-brief` guarantees only that `videos.status` is never mutated (every profile becomes `previewed`, no email is sent, no commit happens). It is **not** a true no-write dry run: channel/video discovery, `video_scores`/`video_embeddings` writes from relevance scoring, and `video_transcripts` cache/retry-state writes from transcript enrichment all still happen exactly as in a real run. For manual, genuinely side-effect-free verification of transcript grounding against specific videos, use the preview script instead:

```bash
BRIEFING_DB_PATH=/tmp/briefing-preview.db npm run preview -w @secondbrain/youtube-briefing -- \
  --profile-id demo --video-id <videoId> --video-id <anotherVideoId>
```

It refuses to run without an explicit `BRIEFING_DB_PATH`, and refuses the default tracked database outright. It fetches (or reuses a cached) transcript for each given video ID, prints segment counts/timestamps, builds a grounded digest, prints it as text, and never calls the email sender. Run it twice with the same `BRIEFING_DB_PATH` to confirm the second run is a cache hit.

## Other Phase docs

- **Channel Monitoring**: polls configured channels, inserts new videos with `status = 'new'`.
- **Relevance Scoring**: embedding-based similarity to profile interests (relevance) and dissimilarity to a knowledge base (novelty), combined 60/40.
- **Multi-profile runs**: every targeted profile's candidates are scored, enriched, and digest-built before any global video status is committed. A non-dry run commits the union of all profiles' selected videos to `processed` only if every profile reached `delivered` or `successful_empty`, every non-empty digest had at least one active subscriber, and no email send failed - otherwise no video status changes for that run (a possible duplicate delivery on retry is preferred over starving a profile).
- **Email Delivery**: Resend API, HTML + plain-text bodies.
