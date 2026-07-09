import { Suspense } from "react";

// Segment layout for /dashboard/pipeline-health/*. Wraps children in Suspense so the pipeline-health
// page and its Mario accuracy card can safely read dynamic data (director_activity + mario_thresholds)
// under Next 16's cacheComponents. mario-reactive-box-agent Phase 4.
export default function PipelineHealthLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
