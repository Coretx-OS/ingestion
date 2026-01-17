
Second Brain OS — QA Checklist
Status: Draft
Last updated: 2026-01-10
Scope: MVP trust-first behaviours, edge cases, and acceptance criteria.

A) Core loop QA (capture → classify → file/log)
 Capture with normal text returns filed when unambiguous

 Capture always creates inbox_log entry (even on failures)

 raw_text stored exactly as entered

 links array contains URL when provided; empty array when not

 Canonical record JSON matches schema (including null fields)

 Confidence always present and between 0 and 1

B) Needs-review QA (confidence gate)
 If confidence < 0.60, response is needs_review

 Needs-review does not create a record row

 clarification_question present and human-readable

 User can resolve needs-review via Fix

 No silent filing on uncertain cases

C) Fix loop QA (repairability)
 Fix requires one interaction

 Reclassifying type nulls incompatible fields

 Fix preserves existing values unless user explicitly changes them

 Fix updates inbox_log status=fixed

 Fix returns change_summary

D) Digest / Review QA
 Daily digest <=150 words (enforced server-side)

 Weekly review <=250 words (enforced server-side)

 Actions are executable (verb + object)

 Empty-state outputs remain useful

E) Logging / Trust QA
 For every capture, trace raw_text → decision → destination

 Model JSON errors become needs_review and are visible via log

 No “mystery failures”: UI always shows a meaningful state

F) Restartability QA
 System works immediately after inactivity

 Needs-review queue cannot become a backlog monster
