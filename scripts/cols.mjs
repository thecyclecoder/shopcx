import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const { data, error } = await admin.from("ticket_messages").select("*").limit(1);
if (error) console.log("ERR:", error);
console.log("rows:", data?.length);
console.log(Object.keys(data?.[0] || {}).join("\n"));
