import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
await admin
  .from("tickets")
  .update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  .eq("id", "5b088362-ac07-4c9b-919d-7495b9b1a8ed");
console.log("✓ Marlene's ticket closed");
