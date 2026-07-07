import { createAdminClient } from "./_bootstrap";
async function main() {
  const admin = createAdminClient();
  const ws = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
  // Examples of specs whose parent points at a FUNCTION mandate (not a goal) and that Vale cleared.
  const { data } = await admin
    .from("specs")
    .select("slug, owner, parent, parent_kind, parent_ref, vale_pass, vale_review_passed_at, status")
    .eq("workspace_id", ws)
    .ilike("parent", "%functions/%")
    .limit(12);
  console.log("=== specs with a FUNCTIONS-mandate parent ===");
  for (const s of data ?? []) console.log(`\n[${s.slug}] owner=${s.owner} vale_pass=${s.vale_pass} vrp=${!!s.vale_review_passed_at} kind=${s.parent_kind} ref=${s.parent_ref}\n  parent: ${(s.parent||"").slice(0,180)}`);
  // the two target specs
  const { data: t } = await admin.from("specs").select("slug, owner, parent, parent_kind, parent_ref").in("slug", ["content-upload-and-lander-build","god-mode"]).eq("workspace_id", ws);
  console.log("\n\n=== TARGET specs current parent ===");
  for (const s of t ?? []) console.log(`\n[${s.slug}] owner=${s.owner} kind=${s.parent_kind} ref=${s.parent_ref}\n  parent: ${s.parent}`);
}
main().then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1);});
