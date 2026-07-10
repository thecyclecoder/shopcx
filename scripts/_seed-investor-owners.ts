import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
type Role = "investor" | "owner";
const OWNERS: { first: string; last: string; email: string; phone: string; role: Role }[] = [
  { first: "David", last: "Stecher", email: "dstecher@stechercapital.com", phone: "+16198079796", role: "investor" },
  { first: "Dylan", last: "Ralston", email: "dylan@superfoodscompany.com", phone: "+18583349198", role: "owner" },
  { first: "Alan", last: "Gold", email: "adg@alan.gold", phone: "+18583953764", role: "investor" },
];

async function main() {
  const admin = createAdminClient();
  for (const o of OWNERS) {
    const { data: existing } = await admin.from("customers")
      .select("id, first_name, last_name, phone, comp_role, tags").ilike("email", o.email).eq("workspace_id", WS).maybeSingle();
    const note = `superfoods company ${o.role}`;
    if (existing) {
      const tags: string[] = ((existing.tags as string[]) ?? []).slice();
      const label = o.role === "owner" ? "Owner" : "Investor";
      if (!tags.includes(label)) tags.push(label);
      const { error } = await admin.from("customers").update({
        first_name: existing.first_name || o.first,
        last_name: existing.last_name || o.last,
        phone: o.phone,
        comp_role: o.role,
        comp_note: note,
        tags,
        valid_email: true,
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      console.log(`UPDATED ${o.first} ${o.last} (${existing.id}) role=${o.role} phone=${o.phone} ${error?.message ?? "ok"}`);
    } else {
      const { data, error } = await admin.from("customers").insert({
        workspace_id: WS,
        email: o.email,
        first_name: o.first,
        last_name: o.last,
        phone: o.phone,
        comp_role: o.role,
        comp_note: note,
        tags: [o.role === "owner" ? "Owner" : "Investor"],
        valid_email: true,
        is_internal: true,
      }).select("id").single();
      console.log(`CREATED ${o.first} ${o.last} (${data?.id ?? "?"}) role=${o.role} phone=${o.phone} ${error?.message ?? "ok"}`);
    }
  }
  // verify
  console.log("\n--- verify ---");
  for (const o of OWNERS) {
    const { data } = await admin.from("customers").select("id,first_name,last_name,email,phone,comp_role,comp_note,tags,valid_email")
      .ilike("email", o.email).eq("workspace_id", WS).maybeSingle();
    console.log(JSON.stringify(data));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
