import type { CaptureRequest } from "../../domain/types.js";

/**
 * Builds the classifier input string from a CaptureRequest body.
 * This ensures the route and tests always send identical input to the LLM.
 */
export function buildClassifierInputFromCapture(body: CaptureRequest): string {
  return JSON.stringify({
    raw_text: body.capture.raw_text,
    context: {
      url: body.capture.context.url,
      page_title: body.capture.context.page_title,
      selected_text: body.capture.context.selected_text,
    },
  });
}
