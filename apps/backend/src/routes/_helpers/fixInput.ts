import type { CanonicalRecord } from "../../domain/types.js";

/**
 * Builds the fix input string for the LLM.
 * This ensures the route and tests always send identical input to the LLM.
 */
export function buildFixInput(userCorrection: string, existingRecord: CanonicalRecord): string {
  return JSON.stringify({
    user_correction: userCorrection,
    existing_record: existingRecord,
  });
}
