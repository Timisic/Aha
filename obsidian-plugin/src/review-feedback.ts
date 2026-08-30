import type { AhaSessionFeedback } from "./session-store";
import type { ReviewBenchmarkSeedAction } from "./review-note";
import { sameNotePath } from "./core/note-identity";

/** Surprise is additive; classification follows the last saved action. */
export function savedReviewActions(feedback: AhaSessionFeedback[], notePath: string): Set<ReviewBenchmarkSeedAction> {
  const actions = new Set<ReviewBenchmarkSeedAction>();
  for (const entry of feedback) {
    let matches = entry.memory === notePath;
    try { matches ||= sameNotePath(entry.memory, notePath); } catch { /* Not a URI. */ }
    if (!matches) continue;
    if (entry.action === "surprise") actions.add("surprise");
    else {
      actions.delete("accept");
      actions.delete("reject_as_noise");
      actions.delete("should_have_found");
      actions.add(entry.action);
    }
  }
  return actions;
}
