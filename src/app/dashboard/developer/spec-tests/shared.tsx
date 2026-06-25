/**
 * Shared helpers for the spec-test surfaces — the Human-test queue
 * (/dashboard/developer/spec-tests/human-queue) and the Regressions page
 * (/dashboard/developer/regressions). Both read /api/developer/spec-test/human-queue
 * and render the same row shapes; these are the bits they have in common.
 */

export type Resolution = "verified" | "failed" | "dismissed";

export interface QueueItem {
  slug: string;
  title: string;
  text: string;
  evidence?: string;
  check_key: string;
  run_at: string;
  resolution: Resolution | null;
  resolved_at: string | null;
  note: string | null;
}

export interface Regression {
  slug: string;
  title: string;
  run_at: string;
  agent_verdict: string;
  failing: { text: string; evidence?: string; check_key: string }[];
}

export interface QueueData {
  items: QueueItem[];
  regressions: Regression[];
  counts: { waiting: number; resolved: number; regressions: number };
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Evidence({ text }: { text: string }) {
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
        evidence
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 text-[11px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
        {text}
      </pre>
    </details>
  );
}
