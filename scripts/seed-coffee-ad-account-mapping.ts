// seed-coffee-ad-account-mapping — seed the one known product_ad_account_mappings row
// (growth-acquisition-roas-spine Phase 3): coffee linked-group → the 'Amazing Coffee & Creamer'
// Meta ad account (internal meta_ad_accounts.id prefix 'd6d619a5'). Idempotent upsert on
// (group_id, meta_ad_account_id).
//
// The account also serves CREAMER, so is_shared_account=true at spend_share=1.0 → AcqROAS reads as a
// CONSERVATIVE FLOOR (the denominator carries creamer's spend too) — exactly the spec's 1.69 baseline.
//
// Note: 'd6d619a5' is the internal meta_ad_accounts.id UUID prefix (NOT the numeric Meta
// meta_account_id, which gets the `act_` prefix). We resolve by id prefix, falling back to the
// account name, and print what we resolved before writing.
//
//   npx tsx scripts/seed-coffee-ad-account-mapping.ts
import { createAdminClient } from "./_bootstrap";

const ACCOUNT_ID_PREFIX = "d6d619a5";        // internal meta_ad_accounts.id prefix (spec Phase 3)
const ACCOUNT_NAME_RE = /coffee\s*&?\s*(and\s*)?creamer/i; // fallback match on meta_account_name

async function main() {
  const admin = createAdminClient();

  const { data: ws } = await admin.from("workspaces").select("id").eq("name", "Superfoods Company").single();
  if (!ws) throw new Error("workspace 'Superfoods Company' not found");

  // ── Resolve the 'Amazing Coffee & Creamer' ad account by internal id prefix (fallback: name) ──
  const { data: accts } = await admin
    .from("meta_ad_accounts")
    .select("id, meta_account_id, meta_account_name")
    .eq("workspace_id", ws.id);
  const accounts = accts || [];
  let acct = accounts.find((a) => String(a.id).startsWith(ACCOUNT_ID_PREFIX));
  if (!acct) acct = accounts.find((a) => ACCOUNT_NAME_RE.test(a.meta_account_name || ""));
  if (!acct) {
    console.log("ad accounts:", accounts.map((a) => ({ id: a.id, name: a.meta_account_name })));
    throw new Error(`no meta_ad_account with id prefix '${ACCOUNT_ID_PREFIX}' or a coffee/creamer name`);
  }
  console.log(`ad account: ${acct.meta_account_name} (id=${acct.id}, meta_account_id=${acct.meta_account_id})`);

  // ── Resolve the coffee linked-group (Amazing Coffee + K-Cups) ──
  // Match by name; exclude the creamer/mug-named groups. Require exactly one survivor.
  const { data: groups } = await admin
    .from("product_link_groups")
    .select("id, name, link_type")
    .eq("workspace_id", ws.id)
    .ilike("name", "%coffee%");
  const coffeeGroups = (groups || []).filter(
    (g) => !/creamer|mug/i.test(g.name || ""),
  );
  if (coffeeGroups.length === 0) {
    console.log("coffee-name groups:", groups);
    throw new Error("no product_link_group resolves to the coffee line");
  }
  if (coffeeGroups.length > 1) {
    console.log("candidate coffee groups:", coffeeGroups);
    throw new Error("ambiguous coffee group — set the group_id explicitly before seeding");
  }
  const group = coffeeGroups[0];
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
