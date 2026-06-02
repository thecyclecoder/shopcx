import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "/Users/admin/Projects/shopcx/scripts/env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data } = await admin.from("returns").select("*").limit(1);
console.log(Object.keys(data?.[0] || {}));
