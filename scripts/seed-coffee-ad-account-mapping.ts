// seed-coffee-ad-account-mapping — seed the one known product_ad_account_mappings row
// (growth-acquisition-roas-spine Phase 3): coffee linked-group → the 'Amazing Coffee & Creamer'
// Meta ad account (meta_account_id 'd6d619a5'). Idempotent upsert on (group_id, meta_ad_account_id).
//
// The account also serves CREAMER, so is_shared_account=true at spend_share=1.0 → AcqROAS reads as a
// CONSERVATIVE FLOOR (the denominator carries creamer's spend too) — exactly the spec's 1.69 baseline.
//
//   npx tsx scripts/seed-coffee-ad-account-mapping.ts
import { createAdminClient } from "./_bootstrap";

const META_ACCOUNT_ID = "d6d619a5"; // 'Amazing Coffee & Creamer' (spec Phase 3)

async function main() {
  const admin = createAdminClient();

  const { data: ws } = await admin.from("workspaces").select("id").eq("name", "Superfoods Company").single();
  if (!ws) throw new Error("workspace 'Superfoods Company' not found");

  const { data: acct } = await admin
    .from("meta_ad_accounts")
    .select("id, meta_account_id, meta_account_name")
    .eq("workspace_id", ws.id)
    .ilike("meta_account_id", `%${META_ACCOUNT_ID}%`)
    .maybeSingle();
  if (!acct) throw new Error(`meta_ad_account matching '${META_ACCOUNT_ID}' not found`);
  console.log(`ad account: ${acct.meta_account_name} (${acct.meta_account_id})`);

  // The coffee linked-group (Amazing Coffee + K-Cups). Match by name; require exactly one.
  const { data: groups } = await admin
    .from("product_link_groups")
    .select("id, name, link_type")
    .eq("workspace_id", ws.id)
    .ilike("name", "%coffee%");
  if (!groups || groups.length === 0) throw new Error("no product_link_group matching 'coffee'");
  if (groups.length > 1) {
    console.log("multiple coffee groups:", groups);
    throw new Error("ambiguous coffee group — set the group_id explicitly before seeding");
  }
  const group = groups[0];
  console.log(`coffee group: ${group.name} (${group.id}, link_type=${group.link_type})`);

  const { error } = await admin
    .from("product_ad_account_mappings")
    .upsert(
      {
        workspace_id: ws.id,
        group_id: group.id,
        meta_ad_account_id: acct.id,
        spend_share: 1.0,
        is_shared_account: true,
        credit_amazon_to_meta: true,
        count_all_non_renewal: true,
        notes: "Account serves both coffee and creamer; spend_share 1.0 → AcqROAS is a conservative floor (spec baseline 1.69).",
      },
      { onConflict: "group_id,meta_ad_account_id" },
    );
  if (error) throw error;
  console.log("✓ upserted coffee → 'Amazing Coffee & Creamer' mapping");
}
main().catch((e) => { console.error(e); process.exit(1); });
