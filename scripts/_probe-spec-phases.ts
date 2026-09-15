import { createAdminClient } from "../src/lib/supabase/admin";

(async () => {
  const admin = createAdminClient();

  const { data: spec, error: specError } = await admin
    .from("specs")
    .select("id")
    .eq("slug", "ticket-surfaces-must-read-the-whole-linked-customer")
    .single();

  if (specError || !spec) {
    console.error("Spec not found:", specError);
    process.exit(1);
  }

  const { data, error } = await admin
    .from("spec_phases")
    .select("phase, status")
    .eq("spec_id", spec.id)
    .order("phase", { ascending: true });

  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }

  console.log("Phase statuses for ticket-surfaces-must-read-the-whole-linked-customer:");
  console.log(JSON.stringify(data, null, 2));
  console.log("\nAll shipped?", data?.every((p: any) => p.status === "shipped"));
})();
