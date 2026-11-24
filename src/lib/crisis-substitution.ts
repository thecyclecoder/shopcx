/**
 * crisis-substitution — flag order lines that Amplifier likely shipped as a DIFFERENT flavor.
 *
 * WHY (Dylan 2026-11-24): while a crisis is active, Amplifier ships the out-of-stock (affected)
 * SKU as an alternative flavor (the crisis's default swap). Our `orders.line_items` still record
 * the ORDERED variant — so June read "Cocoa shipped" as ground truth and ruled Yukiko Ban's
 * Hazelnut-for-Cocoa report false three times (tickets e159a032 / 3488aabf). The order row is NOT
 * what the warehouse shipped during a crisis.
 *
 * WHAT
 *   - `annotateCrisisSubstitution(lines, order, activeCrises)` (PURE): marks a line
 *     `likely_substituted=true` + `likely_shipped_flavor` when its variant/sku matches an active
 *     (or resolved-after-ship) crisis's affected SKU AND Amplifier shipped the order on or after the
 *     crisis started. The likely-shipped flavor is the crisis's `default_swap_title`.
 *   - `getSubstitutionCrises(admin, workspaceId)` (SDK accessor): the crises relevant to a
 *     substitution check — active ones plus recently-resolved ones (so an order shipped while a
 *     now-resolved crisis was live still flags). Read crises THROUGH here, never a raw
 *     `.from("crisis_events")` at the call site.
 *
 * Surfaces: Sol's order context (`getCustomerAccount` RECENT ORDERS in sonnet-orchestrator-v2.ts)
 * and June's ground-truth/remedy_state brief (`getCxOrders` / `formatCxOrders` in cx-agent-sdk.ts).
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A crisis narrowed to the fields the substitution check needs. */
export type SubstitutionCrisis = {
  id: string;
  /** The ordered variant that is out of stock — matched against the line's variant_id. */
  affected_variant_id: string | null;
  /** SKU of the affected variant — a fallback match when the line carries no variant_id. */
  affected_sku?: string | null;
  /** The flavor Amplifier ships INSTEAD — surfaced as the likely shipped flavor. */
  default_swap_title?: string | null;
  /** 'active' | 'resolved' | 'draft' — only active/resolved crises substitute. */
  status: string;
  /** When the crisis started — a line only flags if Amplifier shipped on or after this. */
  created_at: string;
  /** When the crisis resolved (null while active). A resolved crisis only covers a ship that
   *  happened before it resolved. */
  resolved_at?: string | null;
};

/** An order line narrowed to the fields the check needs. */
export type SubstitutionLine = {
  variant_id?: string | number | null;
  sku?: string | null;
};

/** Just the Amplifier ship timestamp — what the warehouse actually shipped, and when. */
export type SubstitutionOrder = {
  amplifier_shipped_at?: string | null;
};

/** The substitution verdict stamped onto each line. */
export type CrisisSubstitutionAnnotation = {
  /** True when this line was likely shipped as another flavor during a crisis. */
  likely_substituted: boolean;
  /** The crisis's default swap flavor — what Amplifier most likely shipped instead. */
  likely_shipped_flavor?: string | null;
  /** The crisis that caused the substitution. */
  crisis_id?: string;
};

function parseTs(v: string | null | undefined): number {
  if (!v) return NaN;
  return Date.parse(v);
}

/**
 * PURE. Annotate each line with whether a crisis likely made Amplifier ship a different flavor.
 *
 * A line is `likely_substituted` when ALL hold:
 *   1. its `variant_id` equals (or its `sku` matches) a crisis's `affected_variant_id`/`affected_sku`;
 *   2. the crisis covered the ship — status 'active', OR resolved on/after the ship date; and
 *   3. `order.amplifier_shipped_at` is on or after the crisis's `created_at` (it shipped during it).
 *
 * The likely-shipped flavor is the crisis's `default_swap_title`. The returned objects preserve the
 * input line shape and add the annotation fields.
 */
export function annotateCrisisSubstitution<L extends SubstitutionLine>(
  lines: L[],
  order: SubstitutionOrder,
  activeCrises: SubstitutionCrisis[],
): Array<L & CrisisSubstitutionAnnotation> {
  const shippedAt = parseTs(order?.amplifier_shipped_at);
  return (lines || []).map((line) => {
    const annotated = { ...line, likely_substituted: false } as L & CrisisSubstitutionAnnotation;
    // No Amplifier ship stamp ⇒ the warehouse hasn't shipped this order, so nothing to substitute.
    if (Number.isNaN(shippedAt)) return annotated;

    const lineVariant = line.variant_id != null ? String(line.variant_id) : "";
    const lineSku = line.sku ? String(line.sku).toUpperCase() : "";

    for (const c of activeCrises || []) {
      if (!c.affected_variant_id && !c.affected_sku) continue;
      const variantMatch = !!lineVariant && String(c.affected_variant_id ?? "") === lineVariant;
      const skuMatch = !!lineSku && !!c.affected_sku && String(c.affected_sku).toUpperCase() === lineSku;
      if (!variantMatch && !skuMatch) continue;

      // The crisis has to have been live when Amplifier shipped: either it's still active, or it
      // resolved on/after the ship (so it was active at ship time).
      const resolvedAt = parseTs(c.resolved_at);
      const coversShip =
        c.status === "active" || (!Number.isNaN(resolvedAt) && resolvedAt >= shippedAt);
      if (!coversShip) continue;

      // And the order must have shipped on or after the crisis started.
      const crisisStart = parseTs(c.created_at);
      if (Number.isNaN(crisisStart) || shippedAt < crisisStart) continue;

      return {
        ...annotated,
        likely_substituted: true,
        likely_shipped_flavor: c.default_swap_title ?? null,
        crisis_id: c.id,
      };
    }
    return annotated;
  });
}

/**
 * SDK accessor — crises relevant to a substitution check for a workspace: active ones plus
 * recently-resolved ones. Only crises with a `default_swap_variant_id` substitute (there has to be
 * an alternative flavor to ship), so we filter to those. Read crises through here instead of a raw
 * `.from("crisis_events")` at the call site (CLAUDE.md: raw `.from(...)` with no SDK → STOP).
 *
 * `resolved_at` is derived from `updated_at` on a resolved row — the resolve action stamps
 * `status='resolved'` + `updated_at` in one write (see POST .../crisis/[crisisId] action=resolve).
 */
export async function getSubstitutionCrises(
  admin: Admin,
  workspaceId: string,
): Promise<SubstitutionCrisis[]> {
  const { data } = await admin
    .from("crisis_events")
    .select(
      "id, status, affected_variant_id, affected_sku, default_swap_title, default_swap_variant_id, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "resolved"]);
  const rows = (data as Array<{
    id: string;
    status: string;
    affected_variant_id: string | null;
    affected_sku: string | null;
    default_swap_title: string | null;
    default_swap_variant_id: string | null;
    created_at: string;
    updated_at: string | null;
  }> | null) || [];
  return rows
    .filter((c) => !!c.default_swap_variant_id)
    .map((c) => ({
      id: String(c.id),
      status: String(c.status),
      affected_variant_id: c.affected_variant_id ?? null,
      affected_sku: c.affected_sku ?? null,
      default_swap_title: c.default_swap_title ?? null,
      created_at: String(c.created_at),
      resolved_at: c.status === "resolved" ? c.updated_at ?? null : null,
    }));
}
