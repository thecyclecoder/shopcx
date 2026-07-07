/**
 * _set-god-mode-phone — DISPOSABLE, out-of-band founder-mobile setter for god-mode.
 *
 * Reads the number from GOD_MODE_SMS (env) and writes it to
 * workspaces.god_mode_sms_number for the target workspace. Kept out of source
 * (underscore prefix, fed via env) so the founder's personal number is never
 * committed. resolveFounderPhone (src/lib/god-mode.ts) reads this column first;
 * sendSMS normalizes to E.164 at send time.
 *
 * Usage:
 *   GOD_MODE_SMS=8583349198 WORKSPACE_ID=<uuid> npx tsx scripts/_set-god-mode-phone.ts
 */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const raw = process.env.GOD_MODE_SMS;
  const workspaceId = process.env.WORKSPACE_ID;
  if (!raw) throw new Error("GOD_MODE_SMS env var required");
  if (!workspaceId) throw new Error("WORKSPACE_ID env var required");
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 11) throw new Error(`GOD_MODE_SMS not a US number: ${raw}`);
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;

  const admin = createAdminClient();
  const { data: ws, error: wsErr } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .single();
  if (wsErr || !ws) throw new Error(`workspace ${workspaceId} not found: ${wsErr?.message ?? ""}`);

  const { error: upErr } = await admin
    .from("workspaces")
    .update({ god_mode_sms_number: e164 })
    .eq("id", workspaceId);
  if (upErr) throw new Error(`update failed: ${upErr.message}`);

  console.log(`✓ god_mode_sms_number set for ${ws.name} → ${e164}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
