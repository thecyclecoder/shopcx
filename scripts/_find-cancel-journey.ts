import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("journey_definitions")
    .select("id, slug, name, trigger_type, is_active, description")
    .or("slug.ilike.%cancel%,name.ilike.%cancel%");
  console.log("=== cancel journey_definitions ===");
  for (const j of data || []) console.log(JSON.stringify(j, null, 2));
  if (!data?.length) {
    const { data: all } = await admin.from("journey_definitions").select("id, slug, name, trigger_type, is_active").limit(60);
    console.log("(no cancel match) — all journeys:");
    for (const j of all || []) console.log(JSON.stringify(j));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
