---
title: YouTube Briefing Transcript Grounding
artifact_type: implementation_plan
status: reviewed_ready_for_handoff
repository: Coretx-OS/ingestion
base_branch: integration
target_branch: work/youtube-briefing/transcript-grounding
created_at: 2026-07-11
---

# YouTube Briefing Transcript Grounding — Implementation Plan

## Intent

Upgrade `apps/youtube-briefing` so every digest insight and “Watch key moment” link is grounded in timestamped caption text rather than inferred from a video title and description. Reuse the repository’s existing `TranscriptProvider` abstraction, update the working Node provider to `youtube-transcript@1.3.1`, cache normalized transcripts, handle long videos through evidence-preserving chunk reduction, and derive links from validated transcript evidence.

The implementation must preserve the current channel-monitoring, profile-scoring, digest-email, and SQLite architecture. It must not add Python, `uv`, or a runtime dependency on the Hermes skill directory. The Hermes skill is a behavior reference for language fallback, validation, and long-transcript handling only.

## Confirmed Starting Point

- `packages/core/src/transcript/types.ts` defines a provider interface, but the only concrete provider is application-owned at `apps/backend/src/youtube/providers/youtubeTranscript.ts`.
- The repository lockfile currently resolves `youtube-transcript@1.2.1`. On 2026-07-11 it returned zero segments for all three videos in the latest briefing.
- An isolated test with `youtube-transcript@1.3.1` returned 18, 771, and 23 segments for those videos, matching the Hermes skill’s Python `youtube-transcript-api` results.
- `youtube-transcript@1.3.1` can parse two caption XML formats into the same public response shape without a unit discriminator: srv3 `<p t="…" d="…">` values are milliseconds, while classic `<text start="…" dur="…">` values are seconds. The current shared types do not state a unit, so unconditional division by 1,000 would corrupt classic captions.
- The digest generator currently sends only title, channel, the first 500 description characters, duration, and relevance score to the LLM. It accepts arbitrary model-generated timestamps.
- The current SQLite bootstrap executes `CREATE TABLE IF NOT EXISTS` statements at startup. Adding a new table is compatible with existing databases without altering the checked-in `videos` table.
- `apps/youtube-briefing` currently has no automated tests even though its package defines a Vitest command.

## Success Criteria

1. A captioned video can be enriched into a cached transcript containing language and ordered segments whose time values are explicitly measured in seconds, with fixture-proven normalization for both srv3 and classic caption XML.
2. The provider is owned and exported by `@secondbrain/core`; backend and briefing do not duplicate provider code.
3. Metadata relevance scoring remains unchanged and occurs before transcript retrieval. The briefing fetches transcripts only for ranked, recent digest candidates and continues down the ranking until it has `maxVideos` usable candidates or exhausts a bounded candidate pool.
4. Every digest bullet references a validated evidence item produced from a stored transcript segment range. YouTube URLs are derived from that evidence’s `startSeconds`; the LLM cannot invent a free-form timestamp.
5. Transcripts that fit the final prompt budget are supplied directly as application-owned segment windows. Overflow transcripts use bounded, profile-aware chunk extraction; the final digest call performs reduction without a separate reducer.
6. Transcripts currently unavailable under the active provider policy do not produce metadata-only bullets or invented timestamps. Transient retrieval failures remain retryable and do not consume the video.
7. Existing databases initialize the transcript cache schema safely and existing videos remain eligible for enrichment.
8. Live API calls are not required in CI. Provider, chunking, validation, cache, and digest behavior are covered with deterministic fixtures and mocked clients.
9. Every targeted profile snapshots ranked candidates before any profile can mutate global video status; two profiles can consider the same video in one run.

## Scope

### In scope

- Upgrade and relocate the YouTube transcript provider into `packages/core`.
- Make transcript time units explicit and normalize milliseconds to seconds at the provider boundary.
- Add configurable language preference/fallback behavior supported by the Node package.
- Add a SQLite transcript cache and retrieval-attempt metadata.
- Select a bounded set of ranked candidates for transcript enrichment.
- Convert full transcripts into bounded evidence records using chunked LLM analysis.
- Make final digest generation select validated evidence IDs.
- Suppress captions currently unavailable under the active policy, periodically recheck negative outcomes, and retry transient failures safely.
- Add briefing and core tests, fixtures, observability, and documentation.
- Prevent global `videos.status` mutation from starving later profiles in the same run by snapshotting all profile candidates and deferring status updates.

### Out of scope

- Official YouTube OAuth caption download; it cannot download arbitrary third-party captions.
- Python, `uv`, subprocesses, or direct use of `~/.hermes/.../SKILL.md` at runtime.
- Downloading audio or adding Whisper speech-to-text fallback.
- Changing the 60/40 metadata relevance/novelty formula.
- Replacing SQLite, Express, OpenAI, Resend, or the external scheduler.
- A user interface for transcripts or digest administration.
- Replacement of global video lifecycle with a durable profile-specific consumption table. This plan uses a bounded snapshot/deferred-mutation correction instead.
- General delivery-system redesign beyond the transaction and deferred-status behavior required to keep transcript-grounded multi-profile runs correct.

## Target Architecture

```text
YouTube monitor
  -> videos (metadata, status=new)
  -> metadata embedding and profile score
  -> snapshot bounded candidate pools for all targeted profiles
  -> shared YouTubeTranscriptProvider
  -> video_transcripts cache (seconds + segment JSON)
  -> direct segment windows when within budget
  -> profile-aware chunk evidence extraction only on overflow
  -> validated evidence IDs
  -> profile-aware digest bullets
  -> timestamp URL derived from evidence.startSeconds
  -> transactional non-empty digest persistence and email delivery
  -> defer global video status mutation until every targeted profile succeeds
```

### Shared transcript contract

Replace the unit-ambiguous segment contract with explicit names:

```ts
export interface TranscriptSegment {
  text: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface TranscriptResult {
  fullText: string;
  language: string | null;
  segments: TranscriptSegment[];
}
```

The provider must guarantee that segments are ordered, finite, non-negative, and normalized to seconds. Consumers must not know which upstream XML format supplied the values. The implementation must pin `youtube-transcript` exactly to `1.3.1`, inject its supported custom `fetch`, inspect a cloned caption response body, and normalize srv3 values while preserving classic values. Unknown non-empty formats fail closed as retryable parser errors; numeric magnitude must never be used to guess units.

### Transcript cache

Add a `video_transcripts` table rather than columns on `videos`, allowing the existing startup schema to create it for both new and established databases:

```text
video_id                  primary key + FK to videos.video_id
status                    available | unavailable | retryable_failure
provider                  provider/version identifier
policy_key                provider version + languages + fallback + segment schema version
language                  nullable
segments_json             nullable
attempt_count             integer
last_attempted_at         timestamp
next_retry_at             nullable timestamp
error_code                nullable stable code
error_message             nullable diagnostic text
created_at / updated_at   timestamps
```

Normalized segments are the canonical payload; derive `fullText` on read rather than duplicating it. Do not store secrets, HTTP response bodies, or stack traces in this table. Validate cached JSON when reading; an invalid cache entry is a retryable cache failure, not evidence. A policy-key change invalidates prior negative cache decisions. “Unavailable” means unavailable under the recorded policy, not permanently unavailable forever; apply a long recheck TTL or explicit force refresh.

### Evidence representation

The LLM must not return an unrestricted timestamp. Assign stable evidence IDs to transcript ranges and retain their source times:

```ts
export interface TranscriptEvidence {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
  insight: string;
  tags: string[];
}
```

Application code assigns segment IDs. In direct mode, the final prompt returns bounded start/end segment references plus bullet text, rationale, and tags. In overflow mode, chunk prompts return bounded start/end references and the final prompt selects from the resulting validated evidence records. Models never create evidence IDs. Application code requires same-video, ordered, contiguous, bounded ranges, reconstructs the excerpt and timestamps, and then creates a stable evidence ID. Persist each bullet with complete evidence provenance (`evidenceId`, source segment IDs, start/end seconds, and excerpt), not an otherwise unresolvable ID. Application code derives `videoId`, title, channel, and timestamp URL rather than trusting duplicated model fields. Transcript text is delimited and treated as untrusted data in every prompt.

### Default execution budgets

Use explicit configuration with these conservative first-release defaults:

| Budget | Default | Scope/enforcement |
|---|---:|---|
| Ranked candidate rows | `30` | Per profile, after cache eligibility filtering |
| Live transcript provider attempts | `20` | Per run; cache hits do not count |
| Provider deadline | `12 seconds` | One total deadline per video across all package fallbacks/language attempts |
| Retry horizon | `7 days` | Due retry rows may remain eligible beyond the normal 24-hour freshness window |
| Retry schedule | `15m, 2h, 12h, 24h` | Then daily until the retry horizon expires |
| Unavailable recheck TTL | `30 days` | Earlier only through force refresh or policy-key change |
| Final digest serialized input | `72,000 characters` | Per profile and in every mode, including static prompt, profile, metadata, transcript windows, and evidence JSON |
| Final digest content payload | `60,000 characters` | Direct transcript windows or accumulated overflow evidence; reserve `12,000` characters for prompt/profile/metadata overhead |
| Overflow chunk text | `24,000 characters` | Per evidence call, complete segments only, with up to `1,000` characters of complete-segment overlap |
| Overflow evidence calls | `6` | Reserved independently per profile; maximum concurrency `2` |
| Evidence candidates | `3` | Maximum returned per overflow call and validated before accumulation |
| Evidence output | `800 tokens` | Per overflow call; extend the shared LLM request contract if needed to enforce pre-call |
| Final digest output | `2,000 tokens` | One reserved final call per profile |
| Profile LLM deadline | `120 seconds` | Covers overflow extraction plus the reserved final call |

Reserve the final call before starting overflow extraction. Before every final call, serialize the complete model input and reject/defer it if it exceeds 72,000 characters in either direct or overflow mode. Direct windows and accumulated overflow evidence share the 60,000-character content-payload cap. If overflow evidence exceeds that cap, drop the lowest-ranked whole evidence records until it fits; never truncate an excerpt away from its validated segment provenance. Each profile receives its own fixed call/input/deadline allowance; unused capacity is not required to be shared, so sequential profile order cannot consume another profile's reservation. Pre-call serialized-input/call/output/deadline checks are the hard controls. Post-call `LLMCallResult.usage` is recorded only for accounting and stopping later optional work; it is not treated as a retroactive enforcement mechanism. Budget exhaustion produces a `deferred` profile/candidate outcome and never changes video status.

### Profile outcomes and global status commit

Every targeted profile must end in exactly one run-level outcome:

| Outcome | Meaning | Blocks global video status update? |
|---|---|---:|
| `delivered` | Non-empty digest persisted; at least one active subscriber; every send succeeded | No |
| `successful_empty` | No evidence-backed bullet exists after bounded, non-deferred processing; no digest persisted or sent | No |
| `previewed` | Dry-run/preview result | Yes; dry runs never update global status |
| `deferred` | Transcript or LLM budget/deadline exhausted before a conclusive empty result | Yes |
| `invalid` | Model output/evidence validation failed | Yes |
| `no_subscribers` | Non-empty digest exists but there is no active recipient | Yes |
| `delivery_failed` | Any subscriber send failed | Yes |
| `failed` | Any other profile pipeline failure | Yes |

Snapshot candidates for all profiles before digest work. Digest construction never mutates status. A non-dry run may atomically mark the union of selected videos globally `processed` only when every targeted profile outcome is `delivered` or `successful_empty`, every non-empty digest had at least one active subscriber, and `emailsFailed === 0`. Otherwise no video status from that run changes; possible duplicate delivery on retry is safer than starving a profile. A successful-empty profile counts as completed but contributes no video IDs to the union.

## Test Plan (Tests First)

### 1. Shared provider contract tests

Add deterministic tests around the actual package parser using an injected fixture-backed `fetch`:

- normalizes srv3 millisecond timing to seconds;
- preserves classic XML timing that is already in seconds;
- fails closed on non-empty unknown caption formats rather than guessing from magnitude;
- preserves segment order and joins decoded segment text into `fullText`;
- reports the selected `lang` when available and `null` when the package cannot identify it;
- tries configured languages in order, then optionally retries without a language;
- rejects empty, non-finite, negative, or wholly unusable segment responses;
- maps explicit video-unavailable, captions-disabled, and exhausted configured-language errors to currently-unavailable outcomes;
- maps generic not-available, empty output, timeout, unknown XML, throttling, 429/5xx, and transport failures to retryable errors unless captured transport evidence is stronger;
- enforces one total deadline across the package's InnerTube and HTML fallback requests;
- never logs API keys or raw response payloads.

Do not call live YouTube endpoints in these tests.

### 2. Transcript cache tests

Use a temporary SQLite database initialized from `schema.sql` and assert:

- the new table is created on a database containing pre-existing `videos` rows;
- a successful fetch is serialized and read back without unit drift;
- unavailable results suppress repeated fetch attempts;
- retryable failures respect `next_retry_at` and can later transition to `available`;
- a provider/language/fallback/schema policy-key change invalidates an old negative result;
- malformed `segments_json` is rejected and made retryable;
- concurrent/logically duplicated enrichment requests produce one canonical cache row.

### 3. Candidate enrichment tests

Mock ranked candidates and the transcript service to assert:

- retrieval begins with the highest-scoring recent candidate;
- retrieval stops after `maxVideos` usable transcripts;
- unavailable candidates are skipped and lower-ranked candidates backfill the digest;
- cached unavailable and not-yet-due rows are excluded before applying the candidate limit so they cannot hide lower-ranked usable videos;
- due retry failures remain eligible for a bounded horizon after the normal 24-hour publication window;
- candidate rows examined, live provider calls, and per-language attempts have separate hard limits;
- transient failures do not change `videos.status` to `processed` or `skipped`;
- currently unavailable captions cannot produce a digest bullet;
- a cache hit does not call YouTube again.

### 4. Chunking and evidence tests

Create short, long, and boundary-heavy transcript fixtures and assert:

- chunks split only between segments;
- each chunk stays under the configured character/token budget;
- overlap includes complete segments and does not alter timestamps;
- duplicate evidence from overlap is deterministically deduplicated;
- chunk responses referencing unknown segments are rejected;
- reduced evidence retains the original video and time range;
- empty or invalid chunk analysis cannot be promoted into final evidence;
- a transcript fitting the final budget requires no preliminary LLM call;
- an overflow transcript exercises profile-aware chunk extraction without truncating the tail;
- per-run transcript-input, evidence-call, output-evidence, concurrency, latency, and usage budgets are enforced;
- both direct and overflow final prompts enforce the same 72,000-character complete serialized-input ceiling and 12,000-character overhead reserve;
- overflow evidence over the content cap drops whole lowest-ranked evidence records rather than truncating provenance;
- budget exhaustion defers the candidate without marking it unavailable or processed.

### 5. Digest validation tests

Mock the LLM and assert:

- every accepted bullet references an evidence ID supplied to the prompt;
- unknown, duplicate, or cross-video evidence IDs are rejected;
- output fields and arrays are runtime-validated before persistence;
- timestamp URLs use `Math.floor(evidence.startSeconds)`, not a model value;
- displayed title/channel are loaded from the database, not accepted from model output;
- direct-mode start/end segment references are validated and converted into application-owned evidence IDs before persistence;
- persisted bullets contain enough segment/time/excerpt provenance to resolve and audit each evidence ID later;
- fewer than `maxVideos` transcripts yields a smaller valid digest;
- zero usable transcripts returns an explicit empty result, stores/sends no digest, and does not process videos;
- digest construction is side-effect-free;
- persistence atomically stores a validated non-empty digest with complete evidence provenance and returns selected video IDs for in-memory run-level commit evaluation;
- selected videos are not globally processed until all targeted profiles complete successfully.

### 6. Pipeline tests

Exercise `runDailyBrief` with mocked external services:

- monitor -> metadata score -> transcript enrichment -> evidence -> digest -> email executes in order;
- transcript failures are surfaced in run diagnostics without aborting unrelated profiles;
- counters distinguish candidate videos, transcript successes, currently unavailable outcomes, retryable failures, deferred work, and evidence-backed bullets;
- no email is sent when no evidence-backed bullets exist;
- the current behavior for a successful single-profile run remains intact apart from transcript grounding.
- two profiles can score and select the same top video because all candidate pools are snapshotted before digest construction;
- any profile or delivery failure leaves the run's global video statuses unchanged, preferring possible duplicate delivery on retry over starving a failed profile;
- `digestsGenerated` counts only persisted non-empty digests.
- dry runs always produce `previewed` outcomes and never update global video status;
- `successful_empty` completes a profile, while deferred/invalid/no-subscriber/delivery-failed outcomes block the run-level status commit.

### 7. Manual smoke test

After automated checks pass, run a dry, non-emailing local command against one known short and one known long video. Confirm:

- segment counts and durations match the YouTube transcript;
- evidence excerpts can be found at the linked moments;
- generated links open within the cited segment;
- a second run uses the cache;
- no subscriber email is sent during smoke verification.

Because the current `dry_run` pipeline has unrelated write side effects, implement the smoke as a CLI/test harness that requires an explicit temporary `BRIEFING_DB_PATH`. It must refuse the default tracked database and must not expose a new unauthenticated, expensive HTTP endpoint.

## Implementation Steps

### Step 1 — Lock the shared transcript contract with tests

1. Add Vitest to core plus fixture-backed fetch tests covering srv3 XML, classic XML, disabled captions, missing language, throttling, malformed timing, unknown XML, and empty output.
2. Change `TranscriptSegment` to `startSeconds` and `durationSeconds`; make `segments` required and `language` nullable.
3. Define exported typed transcript errors with stable codes and retryability rather than matching human-readable strings in consumers.
4. Document the provider guarantees in `packages/core/src/transcript/types.ts`.

This is intentionally a breaking internal type change; the repository search shows only the existing backend provider currently constructs these segments.

### Step 2 — Move and repair the provider in `@secondbrain/core`

1. Add exact `youtube-transcript@1.3.1` as a runtime dependency of `@secondbrain/core` and refresh `package-lock.json`.
2. Move the concrete implementation to `packages/core/src/transcript/youtube.ts` and export it through both `packages/core/src/transcript/index.ts` and `packages/core/src/index.ts`.
3. Inject the package's custom `fetch`, clone and inspect the caption response, distinguish srv3 from classic XML, and normalize only srv3 timing to seconds at this boundary.
4. Accept provider options for an ordered language list and whether language-agnostic fallback is permitted.
5. Preserve upstream error objects as `cause`, classify with exported classes/transport evidence rather than message matching, enforce a shared total deadline, and validate normalized segments before returning a `TranscriptResult`.
6. Export a provider factory or class directly; avoid application-level switch statements until a second production provider exists.

### Step 3 — Migrate the backend consumer without changing behavior

1. Replace `apps/backend`’s concrete provider with the shared export.
2. Retain a minimal compatibility module only if it avoids a broad import change; it must delegate rather than duplicate logic.
3. Remove `youtube-transcript` from the backend package if no backend file imports it directly after migration.
4. Update backend transcript uses for the explicit segment fields and nullable language.
5. Keep the existing backend capture behavior and 15,000-character summary limit unchanged in this work; long-form improvement is scoped to the briefing.

### Step 4 — Add transcript cache schema and repository functions

1. Add `video_transcripts` and supporting indexes to `apps/youtube-briefing/src/db/schema.sql`.
2. Add a focused transcript repository module for cache reads, successful upserts, policy-scoped unavailable outcomes, and retryable failure updates.
3. Serialize normalized segments with a policy key containing exact provider version, ordered languages, fallback setting, and segment schema version. Derive `fullText` from segments on read.
4. Define a bounded retry policy for retryable failures and a long recheck TTL/force-refresh path for currently unavailable outcomes.
5. Use explicit `NOT NULL`, defaults, `CHECK` constraints, FK behavior, and indexes. Validate concurrent upserts transactionally, without promising cross-process single-flight fetches unless a lease is implemented.
6. Add a build step that copies `src/db/schema.sql` to `dist/db/schema.sql`, and test database initialization through the built artifact because `tsc` does not copy SQL assets.
7. Ensure initialization is additive for the existing checked-in SQLite database; do not edit or commit runtime `.db`, `-wal`, or `-shm` files as part of implementation.

### Step 5 — Implement bounded transcript enrichment

1. Add a briefing transcript service that composes the shared provider and cache repository.
2. Read language preference from a documented environment variable such as `TRANSCRIPT_LANGUAGES=en` with ordered comma-separated values.
3. Query ranked `new` candidates plus due retry failures within a documented retry horizon. Exclude cached currently-unavailable and not-yet-due rows before applying the limit.
4. Bound candidate rows examined, live provider calls, and language attempts separately. Walk candidates in score order, using cache entries first and fetching only until `maxVideos` usable transcripts are available or a bound is reached.
5. Record currently-unavailable outcomes and continue to lower-ranked candidates. Leave transient failures eligible for later retry.
6. Return structured enrichment statistics to the daily run; do not leak transcript content into logs.

### Step 6 — Add budgeted segment windows and overflow evidence extraction

1. Add pure utilities that assign deterministic segment IDs and group complete segments into bounded windows with small complete-segment overlap.
2. If all windows for selected videos fit the final prompt budget, send them directly to the profile-aware digest prompt with no preliminary LLM call. Require bounded start/end segment references in the response, then create evidence IDs and provenance application-side.
3. Only for overflow transcripts, add a profile-aware chunk prompt that returns at most a configured number of start/end segment references per batch. It must forbid unsupported claims and treat transcript text as delimited untrusted data.
4. Runtime-validate same-video, ordered, contiguous, bounded segment ranges; application code reconstructs excerpts/timestamps and creates evidence IDs.
5. Deduplicate overlapping evidence by video and source segment range.
6. Let the final digest call perform reduction; do not add a separate reducer or profile-neutral evidence cache in the first release.
7. Implement the defaults in the execution-budget table with environment/config overrides. Reserve each profile's final call before overflow work, enforce limits before each call, and defer candidates/profiles that exceed the remaining allowance without status mutation.

### Step 7 — Ground final digest generation

1. Split current generation into side-effect-free digest construction and transactional persistence of a validated non-empty digest.
2. Replace metadata-only `VideoWithTranscript` input with enriched videos and either bounded segment windows or validated overflow evidence. Supply profile themes and relevance/novelty scores.
3. In direct mode require source segment ranges; in overflow mode require one supplied `evidenceId`. Remove `timestampSeconds` and model-owned title/channel from both response contracts.
4. Runtime-validate the complete response: allowed evidence ID, one bullet per selected video unless explicitly permitted, bounded text, valid tags, and no duplicates.
5. Build `videoId`, `videoTitle`, `channelName`, and `timestampUrl` from application-owned records. Use `Math.floor(startSeconds)` for the URL.
6. Persist only validated evidence-backed bullets. If validation leaves no bullets, return an explicit empty result without creating a random digest ID, storing a digest, or changing video status.
7. In one transaction, persist a non-empty digest whose JSON contains complete application-derived evidence provenance and selected video IDs. Return those video IDs to the orchestrator's in-memory run result for deferred global status mutation; preserve the current HTML/text email shape while ensuring “Watch key moment” points to validated evidence.

### Step 8 — Integrate pipeline diagnostics and failure behavior

1. Score and snapshot bounded candidate lists for every targeted profile before constructing or persisting any profile digest.
2. Extend `DailyBriefResult` with transcript counters: cache hits, fetched, unavailable, retryable failures, deferred candidates, evidence calls, usage, and evidence-backed videos.
3. Ensure no transcript content appears in console logs or `daily_brief_runs.execution_json`.
4. Do not mark transient, unavailable, invalid-output, or deferred candidates processed or skipped. Keep the transcript cache as the source of retrieval suppression.
5. Emit one explicit outcome from the profile-outcome table. Apply its exact commit predicate: only a non-dry run whose outcomes are all `delivered` or `successful_empty`, with recipients for every non-empty digest and zero failed emails, may atomically mark the union of selected videos globally processed. Every other outcome leaves all run-level video statuses unchanged and reports the possible-duplicate retry state.
6. Preserve existing email behavior for non-empty grounded digests, suppress email for empty grounded digests, and count only persisted non-empty digests.

### Step 9 — Documentation and operator controls

1. Update the root README’s YouTube Briefing section to state that insights and timestamps are transcript-grounded.
2. Document `TRANSCRIPT_LANGUAGES`, unofficial-provider limitations, cache behavior, retry behavior, and failure expectations.
3. Add a non-emailing CLI preview harness suitable for verification without relying on the currently side-effectful `dry_run` behavior. Require an explicit temporary database path and refuse the default tracked database.
4. Document that the YouTube API key remains responsible for discovery and metadata, not transcript retrieval.
5. Record the fallback decision: Python/Hermes is not a runtime dependency; revisit it only if measured Node-provider failures justify a second provider.

### Step 10 — Verification and handoff

Run, in order:

```bash
npm run test -w @secondbrain/core
npm run test -w @secondbrain/youtube-briefing
npm run typecheck -w @secondbrain/core
npm run typecheck -w @secondbrain/backend
npm run typecheck -w @secondbrain/youtube-briefing
npm run build -w @secondbrain/core
npm run build -w @secondbrain/backend
npm run build -w @secondbrain/youtube-briefing
npm run test:built-db -w @secondbrain/youtube-briefing
```

Add core and briefing test scripts and wire them into the root test command. `test:built-db` must start from a clean briefing `dist`, build the package (or assert the immediately preceding clean build), verify `dist/db/schema.sql` exists, and initialize a temporary database through the built `dist/db/connection.js`. The current root `npm run lint` checks only the extension and does not validate affected packages; either add affected-package lint scripts during implementation or report lint as unavailable rather than treating extension lint as evidence. After local checks, execute the manual smoke test against an explicit temporary database without sending email, inspect the Git diff for accidental database changes, and exclude all `.db`, `-wal`, and `-shm` modifications from the implementation commit.

## Migration and Rollout

1. Land the shared provider/type changes and backend migration in the same PR so no consumer is left against the old contract.
2. Add the transcript cache table additively and copy `schema.sql` into the built artifact; validate initialization against a disposable old-schema fixture without rewriting existing video or digest rows.
3. Do not backfill every historical video. Populate transcripts lazily from ranked, recent candidates.
4. Initially run the new pipeline through the temporary-DB-only CLI preview path for the configured profile and compare evidence links manually.
5. Enable normal email delivery only after short- and long-video smoke checks pass and cache reuse is observed.
6. Monitor transcript success, currently unavailable outcomes, throttling, LLM validation rejection, deferral, and digest counts. Do not log transcript text.
7. If the provider begins returning widespread empty or invalid responses, fail closed by generating no bullets; do not fall back to metadata-generated timestamps.
8. Rollback is application-code-only: revert to the prior digest path if required. The additive transcript table can remain unused; no destructive database rollback is necessary.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Unofficial YouTube endpoint changes | Transcript retrieval may fail broadly | Pin exact tested version 1.3.1, typed errors, success metrics, fail closed, and keep provider behind shared interface |
| Timestamp unit confusion | Links seek to the wrong position | Normalize by recognized XML format to explicit seconds at provider boundary and fixture-test known values |
| Model invents evidence | Misleading digest | Require supplied evidence IDs and derive URL/title/channel in application code |
| Long transcript exceeds context | Tail content omitted or cost spikes | Direct final prompting when content fits; bounded profile-aware overflow extraction without first-N-character truncation |
| Caption language mismatch | Poor or empty transcript | Ordered language preferences, optional language-agnostic fallback, actual/null language recording |
| Repeated unavailable fetches | Rate limiting and latency | Cache policy-scoped unavailable outcomes with a long recheck TTL and back off retryable failures |
| Fetching every discovered upload | Excess requests and slow run | Score metadata first and enrich only a bounded ranked pool |
| Existing checked-in SQLite files change during tests | Runtime data accidentally committed | Temporary test DBs and explicit pre-commit status inspection |
| Prompt/output drift | Invalid persisted digest | Runtime validation at chunk and final digest boundaries |
| Mixed upstream XML timing units | Unconditional conversion corrupts classic captions | Pin 1.3.1, inspect fixture-backed raw XML through injected fetch, normalize by recognized format only |
| First profile consumes videos globally | Later profiles receive no candidates | Snapshot all profile candidates first, construct without side effects, and defer status mutation until all profiles succeed |
| LLM cost/latency explosion on long videos | Daily run becomes slow and expensive | Direct prompt when content fits; profile-aware overflow extraction only; hard call/token/time/concurrency budgets |
| Retry ages out after 24 hours | One transient failure permanently loses a video | Include due retry rows for a bounded horizon beyond normal freshness and filter eligibility before limits |
| SQL schema absent from `dist` | Production startup fails or misses new table | Copy SQL during build and test initialization via built output |

## Handoff Notes

- Implement from a new branch based on current `integration`: `work/youtube-briefing/transcript-grounding`.
- Preserve the local runtime database changes already present from the 2026-07-11 manual run; do not stage, rewrite, or revert them while implementing this plan.
- Use recorded transcript fixtures in CI. A live transcript call is a manual smoke test only.
- The three known live verification IDs are `gROqcBXoz_c` (short), `PRqiGS6fnIM` (long), and `SvMFPKLqYSU` (short). Do not assert their live availability in automated tests.
- Prefer the smallest shared implementation. Do not add a provider registry, subprocess abstraction, or Python fallback until a second production provider is actually adopted.

## References

- `packages/core/src/transcript/types.ts`
- `packages/core/src/transcript/index.ts`
- `apps/backend/src/youtube/providers/youtubeTranscript.ts`
- `apps/backend/src/youtube/transcriptProvider.ts`
- `apps/backend/src/routes/youtube.ts`
- `apps/youtube-briefing/src/db/schema.sql`
- `apps/youtube-briefing/src/relevance/engine.ts`
- `apps/youtube-briefing/src/digest/generator.ts`
- `apps/youtube-briefing/src/scheduler/dailyBrief.ts`
- `/home/robert/.hermes/hermes-agent/skills/media/youtube-content/SKILL.md` (design reference only)
- YouTube Data API `captions.download` documentation: official download requires OAuth and edit permission on the video

## Oracle Review

Oracle reviewed the first draft on 2026-07-11 and returned **change requested / not safe to implement as written**. The reviewed draft's direction was accepted, but the following changes were required and are incorporated in this handoff version:

1. Replace unconditional millisecond conversion with fixture-tested srv3/classic XML format detection, exact `youtube-transcript@1.3.1` pinning, and fail-closed handling for unknown formats.
2. Make candidate selection and status mutation safe for multiple profiles by snapshotting all profile candidates first, making digest construction side-effect-free, and deferring global status changes until all targeted profiles succeed.
3. Use typed conservative error classification, one total provider deadline, policy-keyed negative caching, retries beyond the normal 24-hour freshness window, and eligibility filtering before limits.
4. Simplify long-transcript processing: direct final prompting when content fits, profile-aware overflow extraction only, no first-release reducer/cache, and explicit call/token/time/concurrency budgets.
5. Copy `schema.sql` into `dist`, initialize and preview only against disposable databases, and refuse the tracked default DB in the smoke harness.
6. Let application code create evidence IDs from validated same-video segment ranges; split construction from transactional non-empty persistence and represent empty output explicitly.
7. Add core/briefing test tooling and stop treating the extension-only lint command as coverage for this work.

After these corrections, Oracle's stated recommendation was that the plan would be safe to implement without a Python/Hermes runtime dependency. This file is the corrected handoff version; implementation should not revert any of the seven review-driven constraints above.

Oracle then ran a final handoff gate against this corrected version. After one final clarification that both direct and overflow modes share the same complete serialized final-input ceiling and overhead reservation, the final verdict was **READY**.
