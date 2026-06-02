import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: c } = await admin
  .from("crisis_events")
  .select("name, tier2_coupon_code, tier2_coupon_percent")
  .eq("id", "94af0cbb-9005-4abf-9f93-ccac303907ee")
  .single();
console.log("Crisis tier2 coupon:", c);
