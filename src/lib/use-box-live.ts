"use client";

/**
 * useBoxLive — subscribe a roadmap/box dashboard component to live agent_jobs changes via Realtime
 * BROADCAST, replacing a `setInterval` poll. On each broadcast (or on the slow backstop / tab-return)
 * it calls `refetch()`. Push, not poll: an idle page costs ~nothing and updates the instant a job
 * changes, instead of hammering /api/roadmap/box every few seconds.
 *
 * Mechanism: the DB trigger `agent_jobs_broadcast_trg` (migration 20261203120000) does
 * `realtime.send(..., 'box_change', 'box:<workspace_id>', private)` on every agent_jobs insert/update.
 * We subscribe to the private `box:<workspace_id>` topic (setAuth carries the user's JWT; the
 * realtime.messages `box_broadcast_read` policy authorizes members of that workspace). See
 * docs/brain/recipes/realtime-subscriptions.md.
 *
 * Reliability: broadcast is fire-and-forget (a NOTIFY missed while the socket reconnects is lost), so we
 * ALSO keep a slow backstop poll (`backstopMs`, default 30s — vs the 4-10s it replaces) + a refetch on
 * tab-return. Worst case the page is `backstopMs` stale, never stuck. Broadcasts are debounced (~300ms)
 * so a burst of session_checklist writes during a build collapses into one refetch.
 */

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useWorkspace } from "@/lib/workspace-context";
import type { RealtimeChannel } from "@supabase/supabase-js";

export function useBoxLive(refetch: () => void, opts?: { backstopMs?: number; enabled?: boolean }): void {
  const workspace = useWorkspace();
  const backstopMs = opts?.backstopMs ?? 30_000;
  const enabled = opts?.enabled ?? true;
  // Keep the latest refetch in a ref so re-renders don't tear down the subscription.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!enabled) return;
    const workspaceId = workspace.id;
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    // Coalesce a burst of broadcasts (a live build streams many agent_jobs writes) into one refetch.
    const fire = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!cancelled) refetchRef.current();
      }, 300);
    };

    const supabase = createClient();
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      // Private channel requires the socket to carry the user's JWT (auth.uid() in the policy).
      if (data.session?.access_token) await supabase.realtime.setAuth(data.session.access_token);
      channel = supabase
        .channel(`box:${workspaceId}`, { config: { private: true } })
        .on("broadcast", { event: "box_change" }, () => fire())
        .subscribe();
    })();

    // Backstop: a slow poll (fire-and-forget safety) + refetch when the tab returns to foreground.
    const backstop = setInterval(() => {
      if (document.visibilityState === "visible") refetchRef.current();
    }, backstopMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") refetchRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(backstop);
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, backstopMs, enabled]);
}
