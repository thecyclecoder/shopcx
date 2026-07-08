import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  subscriptionAction,
  subscriptionAddItem,
} from "@/lib/commerce/subscription";

// GET — single crisis detail with full stats
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: crisis, error } = await admin
    .from("crisis_events")
    .select("*")
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !crisis) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Load all customer actions for this crisis
  const { data: actions } = await admin
    .from("crisis_customer_actions")
    .select("*, customers(id, first_name, last_name, email)")
    .eq("crisis_id", crisisId)
    .order("created_at", { ascending: false });

  const allActions = actions || [];

  // Compute stats
  const stats = {
    total: allActions.length,
    by_segment: {
      berry_only: allActions.filter(a => a.segment === "berry_only").length,
      berry_plus: allActions.filter(a => a.segment === "berry_plus").length,
    },
    tier1: {
      sent: allActions.filter(a => a.tier1_sent_at).length,
      accepted: allActions.filter(a => a.tier1_response === "accepted_swap" || a.tier1_response === "accepted_default_swap" || a.tier1_response === "swapped_flavor").length,
      rejected: allActions.filter(a => a.tier1_response === "rejected").length,
      pending: allActions.filter(a => a.tier1_sent_at && !a.tier1_response).length,
    },
    tier2: {
      sent: allActions.filter(a => a.tier2_sent_at).length,
      accepted: allActions.filter(a => a.tier2_response === "swapped_product" || a.tier2_response === "accepted_swap").length,
      rejected: allActions.filter(a => a.tier2_response === "rejected").length,
      pending: allActions.filter(a => a.tier2_sent_at && !a.tier2_response).length,
    },
    tier3: {
      sent: allActions.filter(a => a.tier3_sent_at).length,
      accepted: allActions.filter(a =>
        a.tier3_response === "accepted_pause" || a.tier3_response === "accepted_remove"
      ).length,
      rejected: allActions.filter(a => a.tier3_response === "rejected").length,
      pending: allActions.filter(a => a.tier3_sent_at && !a.tier3_response).length,
    },
    paused: allActions.filter(a => a.paused_at).length,
    removed_auto_readd: allActions.filter(a => a.removed_item_at && a.auto_readd).length,
    removed_permanent: allActions.filter(a => a.removed_item_at && !a.auto_readd).length,
    cancelled: allActions.filter(a => a.cancelled).length,
  };

  // ── Financial impact ──
  // Count affected subscriptions and estimate revenue at risk
  const affectedSku = crisis.affected_sku;
  const affectedVariantId = crisis.affected_variant_id;

  // Phase 4 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
  // Prior code paged every active/paused sub in the workspace to app and
  // ran the item filter + MRR sum in JS — server-side now via
  // public.crisis_affected_subs.
  const { data: crisisAggRows } = await admin.rpc("crisis_affected_subs", {
    p_workspace: workspaceId,
    p_variant_id: affectedVariantId,
    p_sku: affectedSku,
  });
  const crisisAgg = (Array.isArray(crisisAggRows) ? crisisAggRows[0] : crisisAggRows) as {
    affected_count: number | string | null;
    monthly_revenue_cents: number | string | null;
    sub_ids: string[] | null;
  } | null;
  const matchingSubIds = new Set<string>((crisisAgg?.sub_ids ?? []).filter(Boolean));
  const monthlyRevenueCents = Number(crisisAgg?.monthly_revenue_cents ?? 0) || 0;

  // Estimate months at risk
  let monthsAtRisk = 3; // default
  if (crisis.expected_restock_date) {
    const restockDate = new Date(crisis.expected_restock_date);
    const now = new Date();
    monthsAtRisk = Math.max(1, Math.ceil((restockDate.getTime() - now.getTime()) / (30 * 24 * 60 * 60 * 1000)));
  }

  // Affected = subs still with the item + subs already processed (swapped away)
  const processedSubIds = new Set(allActions.map(a => a.subscription_id).filter(Boolean));
  let stillAffected = 0;
  for (const id of matchingSubIds) {
    if (!processedSubIds.has(id)) stillAffected += 1;
  }
  const totalAffected = stillAffected + processedSubIds.size;

  const financialImpact = {
    affected_subscriptions: totalAffected,
    monthly_revenue_at_risk: Math.round(monthlyRevenueCents) / 100,
    months_at_risk: monthsAtRisk,
    total_revenue_at_risk: Math.round(monthlyRevenueCents * monthsAtRisk) / 100,
    annual_revenue_at_risk: Math.round(monthlyRevenueCents * 12) / 100,
    processed_count: allActions.length,
    // Everyone starts as saved. Only "lost" if they explicitly cancelled or permanently removed (no auto_readd).
    lost_count: allActions.filter(a =>
      a.cancelled === true ||
      (a.removed_item_at && a.auto_readd === false)
    ).length,
    saved_count: allActions.length - allActions.filter(a =>
      a.cancelled === true ||
      (a.removed_item_at && a.auto_readd === false)
    ).length,
  };

  return NextResponse.json({ crisis, actions: allActions, stats, financialImpact });
}

// PATCH — update crisis settings + status
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();

  // Allow updating these fields
  const allowedFields = [
    "name", "status", "affected_variant_id", "affected_sku", "affected_product_title",
    "default_swap_variant_id", "default_swap_title",
    "available_flavor_swaps", "available_product_swaps",
    "tier2_coupon_code", "tier2_coupon_percent",
    "expected_restock_date", "lead_time_days", "tier_wait_days",
  ];

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of allowedFields) {
    if (field in body) {
      updates[field] = body[field];
    }
  }

  const { data: crisis, error } = await admin
    .from("crisis_events")
    .update(updates)
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(crisis);
}

// POST — actions (resolve)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();

  if (body.action === "resolve") {
    // Resolve fans out the promised subscription side-effects the tier
    // playbook committed to during the crisis window, then flips the
    // event's status. Each action must be idempotent: a partial failure
    // (e.g. one Appstle 400 mid-loop) or a Resolve re-fire must never
    // double-resume or double-add-item.
    //
    // Enumerate the customer-action rows scoped to THIS crisis + THIS
    // workspace — read the joined subs so we have the shopify_contract_id
    // + status without a second round-trip per row.
    const { data: rows, error: rowsErr } = await admin
      .from("crisis_customer_actions")
      .select(
        "id, subscription_id, paused_at, auto_resume, removed_item_at, auto_readd, cancelled, original_item, subscriptions:subscription_id ( id, shopify_contract_id, status )",
      )
      .eq("crisis_id", crisisId)
      .eq("workspace_id", workspaceId);
    if (rowsErr) return NextResponse.json({ error: rowsErr.message }, { status: 500 });

    type Row = {
      id: string;
      subscription_id: string | null;
      paused_at: string | null;
      auto_resume: boolean | null;
      removed_item_at: string | null;
      auto_readd: boolean | null;
      cancelled: boolean | null;
      original_item: { variant_id?: string | number; quantity?: number } | null;
      subscriptions: { id: string; shopify_contract_id: string | null; status: string | null } | null;
    };

    const actions = (rows ?? []) as unknown as Row[];

    const resumed: { row_id: string; contract_id: string; ok: boolean; error?: string }[] = [];
    const readded: { row_id: string; contract_id: string; variant_id: string; ok: boolean; error?: string }[] = [];
    const skippedAlreadyActive: string[] = [];
    const skippedAlreadyReadded: string[] = [];

    for (const a of actions) {
      // Guard-first (per director coaching): each mutation gates on a
      // confirming predicate against the CURRENT state, not on the row's
      // stale flags alone.
      if (a.cancelled) continue;
      const sub = a.subscriptions;
      if (!sub || !sub.shopify_contract_id) continue;

      // Auto-resume: only fire when the row is flagged paused with
      // auto_resume=true AND the sub is still paused (compare-and-set —
      // do not resume a sub the customer already reactivated, and do not
      // re-resume a sub a prior Resolve re-fire already handled).
      if (a.paused_at && a.auto_resume === true) {
        if (sub.status === "paused") {
          const r = await subscriptionAction(workspaceId, sub.shopify_contract_id, "resume");
          resumed.push({
            row_id: a.id,
            contract_id: sub.shopify_contract_id,
            ok: r.success,
            error: r.error,
          });
        } else {
          skippedAlreadyActive.push(a.id);
        }
      }

      // Re-add: only fire when the row is flagged removed with
      // auto_readd=true AND we still have a variant_id to add back.
      // subscriptionAddItem itself no-ops on already-present variants
      // (subscription-items.ts subAddItem checks the live contract before
      // the write), so a re-fire is safe.
      if (a.removed_item_at && a.auto_readd === true) {
        const variantId = a.original_item?.variant_id;
        if (!variantId) continue;
        const qty = Math.max(1, Number(a.original_item?.quantity ?? 1));
        // subscriptions.items is the local materialization — if the
        // variant is already back on the row, skip the SDK call so a
        // Resolve re-fire doesn't touch Appstle unnecessarily.
        const { data: subRow } = await admin
          .from("subscriptions")
          .select("items")
          .eq("id", a.subscription_id!)
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        const items = (subRow?.items as { variant_id?: string | number }[] | null) || [];
        const alreadyPresent = items.some((it) => String(it.variant_id) === String(variantId));
        if (alreadyPresent) {
          skippedAlreadyReadded.push(a.id);
          continue;
        }
        const r = await subscriptionAddItem(
          workspaceId,
          sub.shopify_contract_id,
          String(variantId),
          qty,
        );
        readded.push({
          row_id: a.id,
          contract_id: sub.shopify_contract_id,
          variant_id: String(variantId),
          ok: r.success,
          error: r.error,
        });
      }
    }

    // Only flip the crisis to `resolved` if EITHER (a) all side-effect
    // attempts succeeded OR (b) the caller opted into partial-resolve
    // (body.force_resolve=true). Otherwise return 207 with the failure
    // list so the operator can retry — flipping status on partial
    // failure is the "not-clean → looks-clean" invariant break the
    // coaching flagged.
    const failed = [...resumed.filter((r) => !r.ok), ...readded.filter((r) => !r.ok)];
    if (failed.length > 0 && !body.force_resolve) {
      return NextResponse.json(
        {
          error: "partial_side_effects_failure",
          summary: `${resumed.filter((r) => r.ok).length} resumed, ${readded.filter((r) => r.ok).length} re-added, ${failed.length} failed — retry or pass force_resolve=true`,
          resumed,
          readded,
          skipped_already_active: skippedAlreadyActive,
          skipped_already_readded: skippedAlreadyReadded,
          failed,
        },
        { status: 207 },
      );
    }

    // Compare-and-set on the status flip: scope to workspace + crisis
    // and require the crisis to still be non-resolved so a concurrent
    // resolve never over-writes an already-resolved row.
    const { data: crisis, error } = await admin
      .from("crisis_events")
      .update({ status: "resolved", updated_at: new Date().toISOString() })
      .eq("id", crisisId)
      .eq("workspace_id", workspaceId)
      .neq("status", "resolved")
      .select()
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      crisis: crisis ?? null,
      side_effects: {
        resumed_count: resumed.filter((r) => r.ok).length,
        readded_count: readded.filter((r) => r.ok).length,
        skipped_already_active: skippedAlreadyActive.length,
        skipped_already_readded: skippedAlreadyReadded.length,
        failed_count: failed.length,
      },
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
