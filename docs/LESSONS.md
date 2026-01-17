# Lessons Learned & Best Practices

This file captures mistakes, fixes, and principles so we don’t re-learn them.

---

## 1. Tooling drift causes cognitive load

Switching from `cat` → `git apply` introduced confusion.

**Lesson:**  
Prefer the simplest possible mechanism unless version control is explicitly needed.

---

## 2. Golden fixtures must be canonical

Mismatch between:
- test runner expectations (`input`, `expect`)
- fixture reality (`request`, `expected`)

caused unnecessary failures.

**Lesson:**  
Document fixture schemas once and treat them as APIs.

---

## 3. Confidence bugs are subtle but dangerous

The “outer vs inner confidence” bug allowed:
- a valid classification
- to store an invalid confidence

**Lesson:**  
Never duplicate authoritative fields without enforced sync.

---

## 4. Native modules demand discipline

Node major mismatches broke `better-sqlite3`.

**Lesson:**  
Pin Node versions early and document them.

---

## 5. Trust is cumulative

A system is abandoned not when it’s wrong — but when errors feel mysterious.

**Lesson:**  
Logs, invariants, and visibility matter more than cleverness.

---

## 6. This project mirrors its product

The codebase itself is a “second brain”:
- capture (fixtures)
- classify (tests)
- review (logs)
- fix (deterministic corrections)

**Design systems the way you want users to think.**

