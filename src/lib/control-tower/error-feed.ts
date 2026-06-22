/**
 * Control Tower — error feed (error-feed-monitoring spec, Phase 1).
 *
 * The capture + page + snapshot layer for the three "hidden surfaces" where
 * failures used to go unseen:
 *   - inngest  — a function that failed after exhausting retries (the
 *                inngest/function.failed handler calls recordError).
 *   - vercel   — a prod runtime error / 500 delivered by a Vercel Log Drain
 *                (/api/webhooks/vercel-logs calls recordError per grouped batch).
 *   - supabase — a non-null Supabase { error } our own code saw (reportDbError) —
 *                the swallowed-error class, caught at the source.
 *
 * Errors are GROUPED by (source, signature): a burst of the same error folds into
 * ONE error_events incident (count++, last_seen_at bumped), not N rows / N pages.
 * The owners are paged on a NEW signature or a re-firing SPIKE, rate-limited to one
 * page per incident per PAGE_COOLDOWN_MS — so 500 of the same 500 = one page.
 *
 * Everything here is BEST-EFFORT and never throws: an error-reporter that can crash
 * the path it's reporting on is worse than the gap it closes.
 *
 * See docs/brain/specs/error-feed-monitoring.md · docs/brain/tables/error_events.md.
 */
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyOpsAlert } from "@/lib/notify-ops-alert";

type Admin = ReturnType<typeof createAdminClient>;

export type ErrorSource = "inngest" | "vercel" | "supabase" | "supabase-logs";

/** Page at most once per incident per this window — a burst = one page (rate-limit). */
const PAGE_COOLDOWN_MS = 30 * 60_000;

const SOURCE_LABEL: Record<ErrorSource, string> = {
  inngest: "Inngest failure",
  vercel: "Vercel error",
  supabase: "Supabase error",
  // The Management Logs feed (Phase 2): DB-level errors our app never saw.
  "supabase-logs": "Supabase DB-log error",
};

/**
 * Normalize an error string into a stable grouping key: lowercase, then strip the
 * volatile bits (uuids, long hex, numbers, quoted ids) so "row 4821 not found" and
 * "row 9173 not found" collapse to ONE signature. A short sha1 of the result.
 */
function normalizeForSignature(parts: string[]): string {
  const joined = parts.filter(Boolean).join(" | ").toLowerCase();
  const stripped = joined
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\b\d[\d,.]*\b/g, "<n>")
    .replace(/["'`].*?["'`]/g, "<str>")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha1").update(stripped).digest("hex").slice(0, 16);
}

/** Build the (source, signature) grouping key for an error. `keyParts` should be the
 *  STABLE bits (function id, route, error class) — not run-specific ids. */
export function signatureFor(source: ErrorSource, keyParts: string[]): string {
  return `${source}:${normalizeForSignature(keyParts)}`;
}

export interface RecordErrorInput {
  source: ErrorSource;
  /** the grouping key parts (stable bits — function id / route / error class). */
  keyParts: string[];
  /** short human-readable label for the panel. */
  title: string;
  /** the fuller / latest message. */
  detail?: string | null;
  /** the latest raw sample (function_id, run_id, path, code, …). */
  sample?: Record<string, unknown> | null;
  /** occurrences folded in this call (a pre-grouped Vercel batch may pass >1). */
  occurrences?: number;
}

/**
 * Record one (grouped) error into error_events and page the owners on a new signature
 * or a re-firing spike (rate-limited). Best-effort — never throws.
 *
 * Returns whether a fresh incident was opened + whether we paged this call (for tests/logs).
 */
export async function recordError(
  input: RecordErrorInput,
  adminClient?: Admin,
): Promise<{ opened: boolean; paged: boolean }> {
  try {
    const admin = adminClient ?? createAdminClient();
    const signature = signatureFor(input.source, input.keyParts);
    const occurrences = Math.max(1, input.occurrences ?? 1);
    const nowIso = new Date().toISOString();

    const { data: existing } = await admin
      .from("error_events")
      .select("id, count, last_paged_at")
      .eq("source", input.source)
      .eq("signature", signature)
      .maybeSingle();

    if (!existing) {
      // New signature → open an incident (status reopened to 'open') + page.
      const { error } = await admin.from("error_events").insert({
        source: input.source,
        signature,
        title: input.title.slice(0, 300),
        detail: input.detail ?? null,
        sample: input.sample ?? null,
        count: occurrences,
        status: "open",
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        last_paged_at: nowIso,
      });
      if (error) {
        // Racing insert (23505) — fall through to the update path.
        if (error.code === "23505") return recordError({ ...input, occurrences }, admin);
        console.warn(`[error-feed] insert failed for ${signature}:`, error.message);
        return { opened: false, paged: false };
      }
      await pageOwners(admin, input, signature, occurrences);
      return { opened: true, paged: true };
    }

    // Existing incident → fold in. Re-page only if past the cooldown (burst = one page).
    const e = existing as { id: string; count: number | null; last_paged_at: string | null };
    const cooledDown = !e.last_paged_at || Date.now() - new Date(e.last_paged_at).getTime() > PAGE_COOLDOWN_MS;
    const paged = cooledDown;
    await admin
      .from("error_events")
      .update({
        title: input.title.slice(0, 300),
        detail: input.detail ?? null,
        sample: input.sample ?? null,
        count: (e.count ?? 0) + occurrences,
        status: "open",
        last_seen_at: nowIso,
        ...(paged ? { last_paged_at: nowIso } : {}),
      })
      .eq("id", e.id);

    if (paged) await pageOwners(admin, input, signature, (e.count ?? 0) + occurrences);
    return { opened: false, paged };
  } catch (err) {
    console.warn("[error-feed] recordError failed:", err instanceof Error ? err.message : err);
    return { opened: false, paged: false };
  }
}

/**
 * The app-layer Supabase DB-error reporter (error-feed-monitoring Phase 1).
 *
 * Call this anywhere code gets a non-null Supabase `{ error }` it would otherwise
 * swallow (the scorecard-upsert class). Pushes it to the Control Tower error feed —
 * no external creds needed. A no-op on a null/undefined error so call sites can
 * `reportDbError(error, …)` unconditionally.
 *
 *   const { error } = await admin.from("x").upsert(rows);
 *   if (error) await reportDbError(error, { op: "scorecard-upsert", table: "x" });
 */
export async function reportDbError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined,
  context: { op: string; table?: string; [k: string]: unknown },
  adminClient?: Admin,
): Promise<void> {
  if (!error) return;
  const message = error.message ?? "unknown Supabase error";
  await recordError(
    {
      source: "supabase",
      keyParts: [context.op, context.table ?? "", error.code ?? "", message],
      title: `${context.op}${context.table ? ` (${context.table})` : ""}: ${message}`.slice(0, 300),
      detail: [message, error.details, error.hint].filter(Boolean).join(" · ") || null,
      sample: { ...context, code: error.code ?? null, details: error.details ?? null, hint: error.hint ?? null },
    },
    adminClient,
  );
}

/** Page the owners of every Slack-connected workspace about an error incident. */
async function pageOwners(admin: Admin, input: RecordErrorInput, signature: string, total: number): Promise<void> {
  const { data } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .in("role", ["owner", "admin"])
    .not("slack_user_id", "is", null);
  const wsIds = Array.from(new Set(((data ?? []) as Array<{ workspace_id: string }>).map((m) => m.workspace_id)));
  for (const wsId of wsIds) {
    await notifyOpsAlert(wsId, {
      title: `Control Tower: ${SOURCE_LABEL[input.source]} 🔴`,
      severity: "critical",
      lines: [
        input.title,
        input.detail ? input.detail.slice(0, 400) : "",
        total > 1 ? `${total} occurrences so far` : "first occurrence",
        "See /dashboard/developer/control-tower",
      ].filter(Boolean),
    });
  }
}

// ── Dashboard snapshot (read-only) ───────────────────────────────────────────

export interface ErrorIncident {
  id: string;
  source: ErrorSource;
  signature: string;
  title: string;
  detail: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export type PanelColor = "green" | "amber" | "red";

export interface ErrorFeedPanel {
  source: ErrorSource;
  /** red if any incident in the last hour, amber if any in the last 24h, else green. */
  color: PanelColor;
  /** incidents seen in the lookback window. */
  incidents: ErrorIncident[];
  /** distinct active signatures in the window. */
  activeSignatures: number;
  /** total occurrences across active signatures. */
  totalOccurrences: number;
}

export interface ErrorFeedSnapshot {
  generatedAt: string;
  panels: ErrorFeedPanel[];
}

const FEED_LOOKBACK_MS = 7 * 24 * 60 * 60_000; // surface the last week of error activity.
const RED_MS = 60 * 60_000; // any error in the last hour ⇒ panel red.
const AMBER_MS = 24 * 60 * 60_000; // any in the last day ⇒ amber.
const PANEL_INCIDENT_LIMIT = 8;

const SOURCES: ErrorSource[] = ["vercel", "inngest", "supabase", "supabase-logs"];

/** READ-ONLY: the per-source error panels for the Control Tower dashboard. */
export async function buildErrorFeedSnapshot(adminClient?: Admin): Promise<ErrorFeedSnapshot> {
  const admin = adminClient ?? createAdminClient();
  const since = new Date(Date.now() - FEED_LOOKBACK_MS).toISOString();

  const { data } = await admin
    .from("error_events")
    .select("id, source, signature, title, detail, count, first_seen_at, last_seen_at")
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false })
    .limit(300);

  const rows = (data ?? []) as Array<ErrorIncident>;
  const panels: ErrorFeedPanel[] = SOURCES.map((source) => {
    const incidents = rows.filter((r) => r.source === source);
    let color: PanelColor = "green";
    for (const inc of incidents) {
      const age = Date.now() - new Date(inc.last_seen_at).getTime();
      if (age <= RED_MS) {
        color = "red";
        break;
      }
      if (age <= AMBER_MS) color = "amber";
    }
    return {
      source,
      color,
      incidents: incidents.slice(0, PANEL_INCIDENT_LIMIT),
      activeSignatures: incidents.length,
      totalOccurrences: incidents.reduce((s, r) => s + (r.count ?? 0), 0),
    };
  });

  return { generatedAt: new Date().toISOString(), panels };
}
