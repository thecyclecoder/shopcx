/**
 * _set-god-mode-pin — DISPOSABLE, out-of-band PIN setter for god-mode.
 *
 * Reads the PIN from GOD_MODE_PIN (env), scrypt-hashes it via
 * src/lib/god-mode.ts hashPin(), and writes ONLY the hash to
 * workspaces.god_mode_pin_hash for the target workspace. The plaintext PIN
 * is NEVER stored, logged, or committed — the whole reason this script has an
 * underscore prefix (do-not-ship / disposable convention) and is fed via env.
 *
 * Usage (one-shot, don't paste the PIN into shell history):
 *   read -s GOD_MODE_PIN && export GOD_MODE_PIN && \
 *     WORKSPACE_ID=<uuid> npx tsx scripts/_set-god-mode-pin.ts && \
 *     unset GOD_MODE_PIN
 *
 * Refuses to run if the PIN is too short (<4) or too long (>12) or non-digit.
 * The workspace_id must exist. Exits non-zero on any failure so a wrapper can
 * detect it.
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { hashPin } from "../src/lib/god-mode";

async function main() {
  const pin = process.env.GOD_MODE_PIN;
  const workspaceId = process.env.WORKSPACE_ID;
  if (!pin) throw new Error("GOD_MODE_PIN env var required (do not pass on CLI — use a shell that doesn't log it)");
  if (!workspaceId) throw new Error("WORKSPACE_ID env var required");
  if (!/^\d{4,12}$/.test(pin)) {
    throw new Error("PIN must be 4-12 digits (numeric only — matches the destructive-approval UX)");
  }

  const admin = createAdminClient();
  const { data: ws, error: wsErr } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .single();
  if (wsErr || !ws) throw new Error(`workspace ${workspaceId} not found: ${wsErr?.message ?? ""}`);

  const hash = hashPin(pin);
  const { error: upErr } = await admin
    .from("workspaces")
    .update({ god_mode_pin_hash: hash })
    .eq("id", workspaceId);
  if (upErr) throw new Error(`update failed: ${upErr.message}`);

  // Never print the PIN. Confirm only the format of what landed.
  console.log(`✓ god_mode_pin_hash set for workspace ${ws.name} (${workspaceId})`);
  console.log(`  format: scrypt:v1:<salt>:<hash>  · length ${hash.length} chars`);
}

main().catch((err) => {
  console.error(errText(err));
  process.exit(1);
});
