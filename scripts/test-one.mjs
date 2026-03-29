import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY } from "./env.mjs";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function decrypt(encrypted) {
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(ciphertextHex, "hex")).toString("utf8") + decipher.final("utf8");
}

const contractId = "27979153581";
const newDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const { data: sub } = await supabase.from("subscriptions").select("id, workspace_id, next_billing_date").eq("shopify_contract_id", contractId).single();
const { data: ws } = await supabase.from("workspaces").select("appstle_api_key_encrypted").eq("id", sub.workspace_id).single();
const apiKey = decrypt(ws.appstle_api_key_encrypted);

console.log("Contract:", contractId);
console.log("Old date:", sub.next_billing_date);
console.log("New date:", newDate.slice(0, 10));

const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(newDate)}`;
const res = await fetch(url, { method: "PUT", headers: { "X-API-Key": apiKey } });
console.log("Appstle response:", res.status, res.statusText);

if (res.ok || res.status === 204) {
  await supabase.from("subscriptions").update({ next_billing_date: newDate, updated_at: new Date().toISOString() }).eq("id", sub.id);
  console.log("DB updated. SUCCESS");
} else {
  const text = await res.text();
  console.log("FAILED:", text);
}
