import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLoyaltySettings, getMember, getRedemptionTiers, pointsToDollarValue } from "@/lib/loyalty";

export const loyaltyBalance: RouteHandler = async ({ auth, route }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  try {
    const settings = await getLoyaltySettings(auth.workspaceId);
    if (!settings.enabled) {
      return jsonOk({ ok: true, route, enabled: false });
    }

    const member = await getMember(auth.workspaceId, auth.loggedInCustomerId);
    if (!member) {
      return jsonOk({
        ok: true, route, enabled: true,
        points_balance: 0, dollar_value: 0,
        tiers: [], unused_coupons: [],
      });
    }

    const tiers = getRedemptionTiers(settings);
    const tiersWithAffordability = tiers.map((t, i) => ({
      index: i,
      label: t.label,
      points_cost: t.points_cost,
      discount_value: t.discount_value,
      affordable: member.points_balance >= t.points_cost,
      points_needed: Math.max(0, t.points_cost - member.points_balance),
    }));

    // Fetch unused loyalty coupons (active or applied, not expired)
    const admin = createAdminClient();
    const { data: redemptions } = await admin
      .from("loyalty_redemptions")
      .select("id, discount_code, discount_value, status, expires_at, reward_tier")
      .eq("workspace_id", auth.workspaceId)
      .eq("member_id", member.id)
      .in("status", ["active", "applied"])
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    return jsonOk({
      ok: true,
      route,
      enabled: true,
      points_balance: member.points_balance,
      dollar_value: pointsToDollarValue(member.points_balance, settings),
      tiers: tiersWithAffordability,
      unused_coupons: (redemptions || []).map(r => ({
        id: r.id,
        code: r.discount_code,
        discount_value: r.discount_value,
        status: r.status,
        expires_at: r.expires_at,
        tier: r.reward_tier,
      })),
    });
  } catch (err) {
    console.error("[portal] loyaltyBalance error:", err instanceof Error ? err.message : err);
    return jsonErr({ error: "loyalty_error", message: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
};
