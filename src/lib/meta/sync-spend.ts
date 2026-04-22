// Meta ad spend sync: fetch daily spend per account from Marketing API

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { getMetaAccountId, metaGraphRequest } from "./api";

interface InsightRow {
  date_start: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

export async function syncMetaAdSpend(params: {
  workspaceId: string;
  adAccountId: string; // our DB ID
  metaAccountId: string; // Meta numeric ID
  accessToken: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}): Promise<{ daysProcessed: number }> {
  const admin = createAdminClient();
  const actId = getMetaAccountId(params.metaAccountId);

  // Fetch insights with daily time increment
  let allRows: InsightRow[] = [];
  let afterCursor: string | null = null;

  do {
    const queryParams: Record<string, string> = {
      level: "account",
      time_range: JSON.stringify({ since: params.startDate, until: params.endDate }),
      fields: "spend,impressions,clicks,actions,action_values",
      time_increment: "1",
      limit: "500",
    };
    if (afterCursor) queryParams.after = afterCursor;

    const data = await metaGraphRequest(params.accessToken, `/${actId}/insights`, queryParams) as {
      data: InsightRow[];
      paging?: { cursors?: { after?: string }; next?: string };
    };

    allRows.push(...(data.data || []));
    afterCursor = data.paging?.next ? (data.paging.cursors?.after || null) : null;
  } while (afterCursor);

  // Upsert daily snapshots
  let daysProcessed = 0;
  for (const row of allRows) {
    const date = row.date_start;
    const spendCents = Math.round(parseFloat(row.spend || "0") * 100);
    const impressions = parseInt(row.impressions || "0");
    const clicks = parseInt(row.clicks || "0");

    // Extract purchase metrics from actions array
    let purchases = 0;
    let purchaseValueCents = 0;
    if (row.actions) {
      const purchaseAction = row.actions.find(a => a.action_type === "purchase");
      if (purchaseAction) purchases = parseInt(purchaseAction.value);
    }
    if (row.action_values) {
      const purchaseValue = row.action_values.find(a => a.action_type === "purchase");
      if (purchaseValue) purchaseValueCents = Math.round(parseFloat(purchaseValue.value) * 100);
    }

    await admin.from("daily_meta_ad_spend").upsert({
      workspace_id: params.workspaceId,
      meta_ad_account_id: params.adAccountId,
      snapshot_date: date,
      spend_cents: spendCents,
      impressions,
      clicks,
      purchases,
      purchase_value_cents: purchaseValueCents,
    }, { onConflict: "meta_ad_account_id,snapshot_date" });

    daysProcessed++;
  }

  // Update last sync
  await admin.from("meta_ad_accounts").update({
    last_sync_at: new Date().toISOString(),
  }).eq("id", params.adAccountId);

  return { daysProcessed };
}
