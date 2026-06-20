"use client";

import { useState } from "react";

/**
 * Regression escalation (spec-test-agent Phase 2). When a shipped spec FAILED its own spec-test (an
 * auto-`fail`), the owner clicks this to seed a box authoring chat (`Fix: {slug}`) with the failing
 * checks as the brief + kick off the first box turn (POST /api/roadmap/chat, action "propose_fix").
 * The box proposes a fix; the owner reviews it under 🧠/✨ New feature → "Resume a recent chat" and
 * finalizes it into a fix spec. The owner triggers + finalizes — the agent only proposes.
 */
export default function ProposeFixButton({ slug, compact }: { slug: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "queuing" | "queued" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function propose() {
    if (state === "queuing" || state === "queued") return;
    setState("queuing");
    setError(null);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, action: "propose_fix" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "could not propose a fix");
      setState("queued");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "could not propose a fix");
    }
  }

  if (state === "queued") {
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
        title="Seed a box authoring chat with this regression's failing checks so it can propose a fix spec"
      >
        {state === "queuing" ? "Proposing…" : "Propose fix spec"}
      </button>
      {error && <span className="text-[11px] text-rose-500">{error}</span>}
    </span>
  );
}
