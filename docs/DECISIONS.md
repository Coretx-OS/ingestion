# Architectural Decisions

This file records *why* decisions were made, not just what they are.

---

## Why golden tests?

Golden tests:
- lock down intent
- decouple testing from LLM variability
- catch schema drift early

They validate **contracts**, not behavior.

---

## Why SQLite?

- Local-first
- Zero ops
- Perfect for a personal system
- Sufficient for current scale

---

## Why Node 20?

- Native module stability
- Predictable ABI for better-sqlite3
- Avoids repeated rebuild failures

---

## Why conservative defaults?

Because:
- Users forgive slowness
- Users do NOT forgive silent mistakes

Trust is the product.

---

## Why not auto-correct low confidence?

Because ambiguity should surface, not be hidden.

Second Brain OS is not a mind-reader — it’s a support system.

