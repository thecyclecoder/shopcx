/**
 * reconcile-swallowed-escalations — one-shot backfill of CEO escalations that were
 * silently swallowed before the source-side fix (the notification-first, error-checked
 * branch in `escalateDiagnosisToCeo`). The going-forward bug is closed; this script
 * walks the last 30 days of `director_activity` `action_kind='escalated'` rows across
 * every workspace and, for each one whose matching CEO `dashboard_notifications` row
 * never landed, re-emits the missing notification carrying explicit `backfill=true` +
 * `backfilled_from_director_activity_id` markers so the CEO knows the card is a replay.
 *
 * Implements docs/brain/specs/director-escalations-must-surface-to-ceo-backfill-swallowed.md
 * Phase 1. The running, dormant-until-autonomous backstop sibling lives at
 * `reconcileSwallowedEscalations` in src/lib/agents/platform-director.ts (Phase 2 of
 * the related spec); this script is the historical-data sweep that does not require
 * Platform autonomy to be on. NOT `_`-prefixed (an executed operational artifact stays
 * in the repo for audit, per `script-conventions`; `.gitignore` `scripts/_*` would
 * otherwise drop it before the worker can run it).
 *
 * Match strategy. The spec body says "LEFT JOIN on metadata.director_activity_id".
 * The live escalate path (`escalateDiagnosisToCeo` in src/lib/agents/platform-director.ts)
 * does not stamp `director_activity_id` on either side — it dedupes on the
 * `dedupe_key` that lives in BOTH the activity row's `metadata` AND the notification
 * row's `metadata`. We honour that real key here (a pure `director_activity_id` match
 * would treat every live-path notification as missing). Idempotency on re-run is
 * doubly protected: (a) the backfilled notification carries the SAME `dedupe_key` so
 * the next pass's swallowed-set excludes it; (b) we stamp the source activity row's
 * `metadata.backfilled_notification_id` (director_activity has no `details` column —
 * only `metadata`) so even a `dedupe_key`-less row is never double-replayed.
 *
 * Dry-run by default — prints what it WOULD insert. Pass --apply to write.
 *
 *   npx tsx scripts/reconcile-swallowed-escalations.ts            # dry run
 *   npx tsx scripts/reconcile-swallowed-escalations.ts --apply    # write + Slack post
 */
import { randomUUID } from "crypto";
import { createAdminClient } from "./_bootstrap";

const APPROVAL_REQUEST_TYPE = "agent_approval_request"; // the actual type the live escalate path uses
const PLATFORM = "platform";
const CEO = "ceo";
const LOOKBACK_DAYS = 30;

type Meta = Record<string, unknown>;

interface DirectorActivityRow {
  id: string;
  workspace_id: string;
  spec_slug: string | null;
  reason: string | null;
  metadata: Meta | null;
  created_at: string;
}

interface NotificationRow {
  workspace_id: string;
  metadata: Meta | null;
}

/** Reconstruct the CEO deep link from the source activity row (the live path stores `deep_link` on the notification, not the ledger). */
function deepLinkFor(specSlug: string | null, meta: Meta): string {
  if (specSlug) return `/dashboard/roadmap/${specSlug}`;
  const goalSlug = meta["goal_slug"];
  if (typeof goalSlug === "string" && goalSlug) return `/dashboard/roadmap/goals/${goalSlug}`;
  return "/dashboard/roadmap";
}

/** Reconstruct a human title from the activity row — original title wasn't stored on `director_activity`. */
function titleFor(escalationKind: string, specSlug: string | null, meta: Meta): string {
  const target =
    specSlug ??
    (typeof meta["goal_slug"] === "string" ? (meta["goal_slug"] as string) : null) ??
    (typeof meta["signature"] === "string" ? (meta["signature"] as string) : "") ??
    "";
  switch (escalationKind) {
    case "loop_guard":
      return `Build stuck: ${target}`;
    case "groom_unsure":
      return `Grooming needs a call: ${target}`;
    case "init-unsure":
    case "initguard":
      return `Initiation needs a call: ${target}`;
    case "new_goal":
      return `Greenlight needed: ${target}`;
    case "external_blocker":
      return `External blocker — your call: ${target}`;
    default:
      return target ? `Escalation needs your call: ${target}` : "Escalation needs your call";
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();
  const startedAt = new Date().toISOString();

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // The escalation ledger — Platform-director-written `escalated` rows in the lookback window across every workspace.
  const { data: acts, error: actsErr } = await admin
    .from("director_activity")
    .select("id, workspace_id, spec_slug, reason, metadata, created_at")
    .eq("director_function", PLATFORM)
    .eq("action_kind", "escalated")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (actsErr) {
    console.error("[reconcile] director_activity query failed:", actsErr.message);
    process.exit(1);
  }
  const escalations = (acts ?? []) as DirectorActivityRow[];
  console.log(`[reconcile] examining ${escalations.length} escalated director_activity row(s) from the last ${LOOKBACK_DAYS} day(s).`);

  // The CEO-routed escalation notifications that ACTUALLY EXIST in the lookback window, keyed by dedupe_key per workspace.
  // We match on dedupe_key (the live path's idempotency key) AND on backfilled_from_director_activity_id (this script's
  // stamp from prior runs). Either match means the activity row's escalation is surfaced.
  const { data: notifs, error: notifsErr } = await admin
    .from("dashboard_notifications")
    .select("workspace_id, metadata")
    .eq("type", APPROVAL_REQUEST_TYPE)
    .gte("created_at", since);
  if (notifsErr) {
    console.error("[reconcile] dashboard_notifications query failed:", notifsErr.message);
    process.exit(1);
  }
  const surfacedDedupe = new Set<string>(); // `${ws}|${dedupeKey}`
  const surfacedFromActivity = new Set<string>(); // `${ws}|${activityId}` — prior backfill stamps
  for (const n of (notifs ?? []) as NotificationRow[]) {
    const m = n.metadata ?? {};
    const ws = n.workspace_id;
    const k = m["dedupe_key"];
    if (typeof k === "string" && k) surfacedDedupe.add(`${ws}|${k}`);
    const fromAct = m["backfilled_from_director_activity_id"];
    if (typeof fromAct === "string" && fromAct) surfacedFromActivity.add(`${ws}|${fromAct}`);
  }

  // Classify each activity row → (already-surfaced | already-backfilled | swallowed | un-keyable).
  interface Swallowed {
    row: DirectorActivityRow;
    dedupeKey: string;
    escalationKind: string;
    diagnosis: string;
    title: string;
    deepLink: string;
  }
  const swallowed: Swallowed[] = [];
  const skipped: { reason: string; row: DirectorActivityRow }[] = [];
  for (const a of escalations) {
    const meta = a.metadata ?? {};
    // Already-backfilled by an earlier run of this script — stamp on the source row is the second idempotency rail.
    if (typeof meta["backfilled_notification_id"] === "string" && meta["backfilled_notification_id"]) {
      skipped.push({ reason: "already-backfilled (stamp on activity row)", row: a });
      continue;
    }
    const dedupeKey = meta["dedupe_key"];
    if (typeof dedupeKey !== "string" || !dedupeKey) {
      // No stable key to match a notification — pre-dedupe-key era or a hand-written row. Skip and log; safer than
      // double-inserting a phantom card.
      skipped.push({ reason: "no dedupe_key on activity row — cannot match", row: a });
      continue;
    }
    if (surfacedDedupe.has(`${a.workspace_id}|${dedupeKey}`)) {
      skipped.push({ reason: "matching CEO notification already exists", row: a });
      continue;
    }
    if (surfacedFromActivity.has(`${a.workspace_id}|${a.id}`)) {
      skipped.push({ reason: "a prior backfill already emitted this notification", row: a });
      continue;
    }
    const escalationKind = String(meta["escalation_kind"] ?? "escalated");
    const diagnosis = String(a.reason ?? "").slice(0, 4000);
    swallowed.push({
      row: a,
      dedupeKey,
      escalationKind,
      diagnosis,
      title: titleFor(escalationKind, a.spec_slug, meta),
      deepLink: deepLinkFor(a.spec_slug, meta),
    });
  }

  // Per-workspace transparency print BEFORE any writes — the Superfoods dry-run number the spec asks for.
  const perWorkspace = new Map<string, number>();
  for (const s of swallowed) perWorkspace.set(s.row.workspace_id, (perWorkspace.get(s.row.workspace_id) ?? 0) + 1);
  console.log(`[reconcile] swallowed → ${swallowed.length} · already-surfaced/backfilled → ${skipped.length}`);
  for (const [ws, n] of perWorkspace) console.log(`  workspace ${ws}: ${n} swallowed escalation(s) to backfill`);

  if (!apply) {
    console.log("\nDry run — pass --apply to insert the missing CEO notifications and stamp the activity rows.");
    for (const s of swallowed) {
      console.log(
        `  WOULD backfill ws=${s.row.workspace_id} activity=${s.row.id} kind=${s.escalationKind} key=${s.dedupeKey} title="${s.title}"`,
      );
    }
    return;
  }

  // Apply mode: insert the missing notification (id generated locally so we don't need .select().single()), then
  // stamp the activity row. Two-step (notification first, stamp second) — if the stamp write fails the worst case
  // is a future run sees the now-existing notification on its dedupe_key and skips the row, which is the right
  // safe outcome. Per-row try/catch so one bad row doesn't drop the rest of the batch.
  let inserted = 0;
  let stamped = 0;
  for (const s of swallowed) {
    try {
      const notifId = randomUUID();
      const notifPayload = {
        id: notifId,
        workspace_id: s.row.workspace_id,
        type: APPROVAL_REQUEST_TYPE,
        title: s.title.slice(0, 200),
        body: `Ada (Platform/DevOps Director) escalated this to you (replayed backfill):\n${s.diagnosis}`.slice(0, 4000),
        link: s.deepLink,
        metadata: {
          routed_to_function: CEO,
          escalated_by_director: PLATFORM,
          escalation_kind: s.escalationKind,
          escalation_reason: s.diagnosis.slice(0, 2000),
          dedupe_key: s.dedupeKey,
          spec_slug: s.row.spec_slug ?? null,
          deep_link: s.deepLink,
          approve_action_id: null,
          backfill: true,
          backfilled_from_director_activity_id: s.row.id,
        },
        read: false,
        dismissed: false,
      };
      const { error: insErr } = await admin.from("dashboard_notifications").insert(notifPayload);
      if (insErr) {
        console.error(`  insert FAILED for activity ${s.row.id} (key=${s.dedupeKey}): ${insErr.message}`);
        continue;
      }
      inserted++;

      const stampedMeta = { ...(s.row.metadata ?? {}), backfilled_notification_id: notifId, backfilled_at: startedAt };
      const { error: upErr } = await admin.from("director_activity").update({ metadata: stampedMeta }).eq("id", s.row.id);
      if (upErr) {
        console.error(`  stamp FAILED for activity ${s.row.id}: ${upErr.message} (notification ${notifId} already inserted — re-run will skip via dedupe_key)`);
        continue;
      }
      stamped++;
      console.log(`  backfilled ws=${s.row.workspace_id} activity=${s.row.id} → notification ${notifId}`);
    } catch (e) {
      console.error(`  exception backfilling activity ${s.row.id}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n[reconcile] inserted ${inserted} CEO notification(s); stamped ${stamped} activity row(s).`);

  // Per-workspace #cto-ada one-liner. Best-effort — a Slack failure must not undo the DB work above. Slack module
  // is loaded LAZILY (mirrors the dynamic-import pattern in scripts/builder-worker.ts) so a chain-resolution
  // hiccup with the `@/` alias in src/lib/slack.ts dependencies never crashes the dry-run or the DB phase.
  let slackMod: typeof import("../src/lib/slack") | null = null;
  for (const [workspaceId, n] of perWorkspace) {
    if (n === 0) continue;
    try {
      const { data: ws } = await admin
        .from("workspaces")
        .select("slack_ada_channel_id")
        .eq("id", workspaceId)
        .maybeSingle();
      const channelId = (ws?.slack_ada_channel_id as string | null) ?? null;
      if (!channelId) {
        console.log(`  [slack] ws=${workspaceId} has no slack_ada_channel_id — skipped Slack post`);
        continue;
      }
      if (!slackMod) slackMod = await import("../src/lib/slack");
      const token = await slackMod.getSlackToken(workspaceId);
      if (!token) {
        console.log(`  [slack] ws=${workspaceId} has no Slack bot token — skipped Slack post`);
        continue;
      }
      const text = `Backfilled ${n} swallowed director escalation${n === 1 ? "" : "s"} from the last ${LOOKBACK_DAYS} days; they're in your inbox now.`;
      const res = await slackMod.postAsAda(token, channelId, [], text);
      if (!res.ok) console.warn(`  [slack] ws=${workspaceId} postAsAda failed`);
    } catch (e) {
      console.warn(`  [slack] ws=${workspaceId} threw:`, e instanceof Error ? e.message : e);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[reconcile] fatal:", e instanceof Error ? `${e.message}\n${e.stack}` : e);
    process.exit(1);
  });
