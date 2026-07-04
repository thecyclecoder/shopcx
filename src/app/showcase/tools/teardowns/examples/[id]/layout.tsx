import { Suspense } from "react";

// Segment layout for /showcase/tools/teardowns/examples/[id]. Wraps children in Suspense
// so the server page can await dynamic DB + storage reads under cacheComponents without
// blocking the static shell prerender. The Showcase password gate lives in src/proxy.ts.
export default function TeardownExampleLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
