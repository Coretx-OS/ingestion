
Second Brain OS — Minimal Repo Structure
Status: Draft
Last updated: 2026-01-10
Scope: Suggested directories and “non-negotiable” contract files.

Suggested structure
secondbrain-os/
backend/
src/
routes/
llm/
db/
domain/
prompts/
openapi.yaml
README.md
tests/
extension/
src/
manifest.json
README.md
docs/

Non-negotiable contract files
backend/openapi.yaml = API truth

backend/src/domain/canonicalRecord.* = canonical schema builder + validator

backend/src/llm/jsonGuard.* = strict JSON parse + safe fallback

backend/src/prompts/*.txt = versioned prompts (treat as API surface)
