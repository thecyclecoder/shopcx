"use client";

import { useState } from "react";

/**
 * Request a fix on a regressed spec. Two delivery modes:
 *
 *   - `mode="inline"` (DEFAULT, used by the spec-test card —
 *     spec-test-request-fix-inline-author-and-approve Phase 1): POST
 *     /api/roadmap/spec-test/request-fix authors the fix spec DIRECTLY via the specs-table SDK
 *     and enqueues its build job, with no `roadmap_chats` round-trip. The owner stays on the
 *     spec-test card (Phase 2 will render the fix's live state + an inline Approve button right
 *     there).
 *   - `mode="chat"` (LEGACY, used by /dashboard/developer/regressions): POST /api/roadmap/chat
 *     action="propose_fix" — seeds a box authoring chat the owner finalizes under 🧠/✨ New
 *     feature → "Resume a recent chat". Kept available for the regressions surface.
 *
 * In both modes the owner triggers + (in chat mode) finalizes; the agent only proposes/authors.
 */
export default function ProposeFixButton({
  slug,
  compact,
  mode = "inline",
}: {
  slug: string;
  compact?: boolean;
  /** "inline" → authors the fix spec + queues the build directly. "chat" → legacy box-spec-chat round-trip. */
  mode?: "inline" | "chat";
}) {
  const [state, setState] = useState<"idle" | "queuing" | "queued" | "error">("idle");
  const [fixSlug, setFixSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function propose() {
    if (state === "queuing" || state === "queued") return;
    setState("queuing");
    setError(null);
    try {
      if (mode === "inline") {
        const res = await fetch("/api/roadmap/spec-test/request-fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
        const d = (await res.json()) as { fixSlug?: string; error?: string };
        if (!res.ok) throw new Error(d.error || "could not request a fix");
        setFixSlug(d.fixSlug ?? null);
      } else {
        const res = await fetch("/api/roadmap/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, action: "propose_fix" }),
        });
        const d = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(d.error || "could not propose a fix");
      }
      setState("queued");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "could not request a fix");
    }
  }

  if (state === "queued") {
    if (mode === "inline") {
      // Phase 1 minimum: stop sending the owner away. Phase 2 replaces this terminal text with the
      // inline fix-state + Approve affordance rendered on the same card.
      return (
        <span className={`text-rose-600 dark:text-rose-400 ${compact ? "text-[11px]" : "text-xs"}`}>
          Fix queued — building <code>{fixSlug ?? `fix-${slug}`}</code>.
        </span>
      );
    }
    return (
      <span className={`text-rose-600 dark:text-rose-400 ${compact ? "text-[11px]" : "text-xs"}`}>
        Drafting a fix on the box — open it under 🧠/✨ New feature → Resume a recent chat (<code>Fix: {slug}</code>).
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={propose}
        disabled={state === "queuing"}
        className={`rounded-md bg-rose-600 font-medium text-white hover:bg-rose-700 disabled:opacity-50 ${
          compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"
        }`}
        title={
          mode === "inline"
            ? "Author a fix spec for this regression's failing checks and queue its build — without leaving this card"
            : "Seed a box authoring chat with this regression's failing checks so it can propose a fix spec"
        }
      >
        {state === "queuing"
          ? mode === "inline"
            ? "Requesting…"
            : "Proposing…"
          : mode === "inline"
            ? "Request a fix"
            : "Propose fix spec"}
      </button>
      {error && <span className="text-[11px] text-rose-500">{error}</span>}
    </span>
  );
}
