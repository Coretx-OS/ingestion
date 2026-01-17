---
name: fix
description: Run typechecking and linting, then spawn parallel agents to fix all issues
---

# Project Code Quality Check

This command runs all linting and typechecking tools for this Chrome Extension project, collects errors, groups them by domain, and spawns parallel agents to fix them.

## Step 1: Run Linting and Typechecking

Run both quality check commands for this TypeScript/React project:

```bash
npm run lint       # ESLint - JavaScript/TypeScript linting
npm run typecheck  # TypeScript - Type checking
```

Store the output from both commands to analyze errors.

## Step 2: Collect and Parse Errors

Parse the output from the linting and typechecking commands. Group errors by domain:

### Type Errors (from `npm run typecheck`)
- TypeScript compilation errors
- Type mismatches, missing types, incompatible types
- Import/export type issues
- Generic type constraint violations

### Lint Errors (from `npm run lint`)
- ESLint rule violations
- TypeScript-specific ESLint rules (@typescript-eslint)
- Code style and quality issues
- Unused variables/imports (must be prefixed with `_`)
- Missing dependencies in React hooks

Create a structured list:
1. **Files with type errors** → List each file with specific type issues
2. **Files with lint errors** → List each file with specific lint violations

## Step 3: Spawn Parallel Agents

**CRITICAL**: Use a SINGLE response with MULTIPLE Task tool calls to run agents in parallel.

Based on the errors found, spawn specialized agents:

### If Type Errors Exist:
Spawn a **type-fixer agent** with:
- Task description: "Fix TypeScript type errors"
- Prompt: "Fix all TypeScript type errors in the following files: [list files]. Specific errors: [list errors]. After fixing, run `npm run typecheck` to verify all type errors are resolved."
- Agent type: general-purpose

### If Lint Errors Exist:
Spawn a **lint-fixer agent** with:
- Task description: "Fix ESLint errors"
- Prompt: "Fix all ESLint errors in the following files: [list files]. Specific errors: [list errors]. Remember: unused variables must be prefixed with `_`. After fixing, run `npm run lint` to verify all lint errors are resolved."
- Agent type: general-purpose

### Example Parallel Execution:
```
<single message with multiple Task tool calls>
Task 1: type-fixer agent
Task 2: lint-fixer agent
</single message>
```

**Each agent should:**
1. Receive the list of files and specific errors in their domain
2. Read each file and understand the context
3. Fix all errors systematically
4. Run the relevant check command (`npm run typecheck` or `npm run lint`) to verify fixes
5. If errors remain, iterate until all are resolved
6. Report completion with summary

## Step 4: Verify All Fixes

After all agents complete, run the full quality check again:

```bash
npm run lint && npm run typecheck
```

Ensure both commands pass with zero errors. If any errors remain, report them to the user with specific details.

## Step 5: Report Results

Provide a summary:
- ✅ Total type errors fixed
- ✅ Total lint errors fixed
- 📁 Files modified
- ⚠️ Any remaining issues (if applicable)
- 🎯 Quality check status: PASSING/FAILING

## Notes

**Common Fixes:**
- Type errors: Add proper type annotations, fix type mismatches, update interfaces
- Lint errors: Fix unused variables (prefix with `_`), remove unused imports, fix React hook dependencies
- Path alias: Remember `@/` maps to `src/` directory

**Project-Specific Rules:**
- ESLint config: `eslint.config.js` (flat config format)
- TypeScript config: `tsconfig.json` (strict mode enabled)
- Unused parameters: Must be prefixed with `_` to avoid ESLint errors
- React hooks: Must include all dependencies in dependency array

**Extension Reload:**
After fixes, if changes affect runtime behavior:
1. Go to `chrome://extensions/`
2. Click refresh icon on extension
3. Test functionality in browser
