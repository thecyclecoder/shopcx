"use client";

/**
 * Shared presentational pieces for the box spec-test agent's report (spec-test-agent): the
 * "Agent-tested" stamp, the compact pass/fail/human chip, and the per-check verdict+evidence list.
 * Pure/structural props (no server imports) so BOTH the server Developer page AND the client
 * VerificationCard can render them. The agent stamps; the human owns the Verified gate (never shown here).
 */

type Verdict = "pass" | "fail" | "needs_human" | "inconclusive";
export interface Check {
  text: string;
  verdict: Verdict | string;
  category?: string;
  evidence?: string;
  /** Browser-check screenshot storage path (raw) — present on the row but not directly renderable. */
  screenshot?: string;
  /** Server-signed URL for the screenshot (spec-test-deep-verification Phase 1) — what we actually render. */
  screenshotUrl?: string | null;
}
export interface Summary {
  auto_pass?: number;
  auto_fail?: number;
  needs_human?: number;
  inconclusive?: number;
}

const VERDICT_DOT: Record<string, string> = {
  approved: "bg-emerald-500",
  issues: "bg-rose-500",
  needs_human: "bg-amber-500",
  error: "bg-zinc-400",
};
const VERDICT_LABEL: Record<string, string> = {
  approved: "Agent-tested",
  issues: "Agent-tested · issues",
  needs_human: "Needs human",
  error: "Run errored — retry",
};
const VERDICT_CLASS: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  issues: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  needs_human: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  error: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300",
};

/** The distinct "Agent-tested ✅ / ⚠️ issues" stamp — sits NEXT TO (never replaces) the human Verified state. */
export function AgentTestedStamp({ verdict }: { verdict: string }) {
  const v = VERDICT_CLASS[verdict] ? verdict : "needs_human";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_CLASS[v]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${VERDICT_DOT[v]}`} />
      {VERDICT_LABEL[v]}
    </span>
  );
}

/** Compact chip "✅ 8 · ✗ 1 · 👤 1 · ? 0" from a run summary. */
export function TestChip({ summary, humanResolved }: { summary: Summary; humanResolved?: number }) {
  const pass = summary.auto_pass ?? 0;
  const fail = summary.auto_fail ?? 0;
  const human = summary.needs_human ?? 0;
  const inc = summary.inconclusive ?? 0;
  // When the board passes the owner's resolution count, show the human checks as DONE vs WAITING — so
  // the archive decision is obvious. Without it (e.g. a detail view), fall back to the raw count.
  const humanWaiting = humanResolved == null ? human : Math.max(0, human - humanResolved);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
      <span className="text-emerald-600 dark:text-emerald-400">✅ {pass}</span>
      {fail > 0 && <span className="text-rose-600 dark:text-rose-400">✗ {fail}</span>}
      {human > 0 &&
        (humanResolved != null && humanWaiting === 0 ? (
          <span className="text-emerald-600 dark:text-emerald-400" title={`all ${human} human check${human === 1 ? "" : "s"} tested`}>👤 ✓ tested</span>
        ) : (
          <span
            className="text-amber-600 dark:text-amber-400"
            title={humanResolved != null ? `${humanWaiting} of ${human} human check${human === 1 ? "" : "s"} still need testing` : `${human} check${human === 1 ? "" : "s"} need human testing`}
          >
            👤 {humanWaiting}{humanResolved != null ? " to test" : ""}
          </span>
        ))}
      {inc > 0 && <span className="text-zinc-400">? {inc}</span>}
    </span>
  );
}

const CHECK_MARK: Record<string, { icon: string; cls: string }> = {
  pass: { icon: "✅", cls: "text-emerald-600 dark:text-emerald-400" },
  fail: { icon: "✗", cls: "text-rose-600 dark:text-rose-400" },
  needs_human: { icon: "👤", cls: "text-amber-600 dark:text-amber-400" },
  inconclusive: { icon: "?", cls: "text-zinc-400" },
};

/** Per-bullet verdicts with expandable evidence. */
export function CheckList({ checks }: { checks: Check[] }) {
  if (!checks.length) return <p className="text-xs text-zinc-400">No checks recorded.</p>;
  return (
    <ul className="space-y-1.5">
      {checks.map((c, i) => {
        const m = CHECK_MARK[c.verdict] ?? CHECK_MARK.inconclusive;
        return (
          <li key={i} className="text-xs">
            <div className="flex items-start gap-1.5">
              <span className={`mt-0.5 flex-shrink-0 font-medium ${m.cls}`}>{m.icon}</span>
              <div className="min-w-0">
                <span className="text-zinc-700 dark:text-zinc-300">{c.text}</span>
                {(c.evidence || c.screenshotUrl) && (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                      evidence{c.screenshotUrl ? " · 📷 screenshot" : ""}
                    </summary>
                    {c.evidence && (
                      <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 text-[11px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
                        {c.evidence}
                      </pre>
                    )}
                    {c.screenshotUrl && (
                      // Browser-check screenshot evidence (spec-test-deep-verification Phase 1).
                      <a href={c.screenshotUrl} target="_blank" rel="noreferrer" className="mt-1 block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={c.screenshotUrl}
                          alt="browser check screenshot"
                          className="max-h-80 w-full rounded border border-zinc-200 object-contain object-top dark:border-zinc-700"
                        />
                      </a>
                    )}
                  </details>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
