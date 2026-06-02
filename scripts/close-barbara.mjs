import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
await admin
  .from("tickets")
  .update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  .eq("id", "699b2282-22b7-4c7a-b471-727c697a1fe7");
console.log("✓ Barbara's ticket closed");
