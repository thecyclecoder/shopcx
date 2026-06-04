/**
 * print-routine-env.ts — emit the env-var block for the agent-todo Claude Code Routine.
 *
 * Anthropic exposes no API/CLI to set Routine env vars programmatically (verified
 * 2026-06-04). The only mechanism is the textarea at claude.ai/code/routines →
 * Edit → Select environment → Environment variables (KEY=value, newline-separated).
 *
 * This reads .env.local, filters to the keys the Routine actually needs, and prints
 * them in that exact textarea format to stdout.
 *
 *   Usage:  npx tsx scripts/print-routine-env.ts | pbcopy
 *           → paste into the Routine's environment-vars textarea → done.
 *
 * Rerun + re-paste whenever secrets rotate. Workaround until Anthropic ships an env API.
 *
 * Per-workspace integration credentials (Appstle / EasyPost / Braintree / Klaviyo /
 * Shopify / Resend) are stored AES-256-GCM encrypted in the DB, not in .env.local —
 * the Routine reads + decrypts them at run time via createAdminClient() + crypto.ts,
 * so the only secret it needs in env to do that is ENCRYPTION_KEY plus Supabase +
 * Anthropic creds. Any of those integration keys that DO live in .env.local are still
 * emitted; ones that don't are reported to stderr (not stdout, so the pipe stays clean).
 *
 * See docs/brain/specs/agent-todo-system.md § Runtime.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Exact keys the Routine needs in its environment.
const EXACT_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_PASSWORD",
  "ENCRYPTION_KEY", // decrypts per-workspace integration credentials from the DB
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY", // embeddings for brain/context lookups
  "INNGEST_EVENT_KEY", // so the Routine can fire agent-todo/execute if needed
  "INNGEST_SIGNING_KEY",
  "RESEND_API_KEY",
  "EASYPOST_API_KEY",
  "NEXT_PUBLIC_SITE_URL",
];

// Prefixes whose every matching key should be emitted (integration families that
// may or may not be present in .env.local depending on whether they're global or
// per-workspace encrypted).
const KEY_PREFIXES = [
  "APPSTLE_",
  "META_",
  "BRAINTREE_",
  "KLAVIYO_",
  "SHOPIFY_",
  "TWILIO_",
];

function parseEnvLocal(): Map<string, string> {
  const path = resolve(process.cwd(), ".env.local");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`error: could not read ${path}. Run from the repo root.`);
    process.exit(1);
  }
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

function main() {
  const env = parseEnvLocal();
  const emitted: string[] = [];
  const missing: string[] = [];

  for (const key of EXACT_KEYS) {
    const val = env.get(key);
    if (val !== undefined && val !== "") emitted.push(`${key}=${val}`);
    else missing.push(key);
  }

  for (const [key, val] of env) {
    if (KEY_PREFIXES.some((p) => key.startsWith(p))) {
      if (val !== "") emitted.push(`${key}=${val}`);
    }
  }

  // De-dupe (a prefixed key could also be in EXACT_KEYS) while preserving order.
  const seen = new Set<string>();
  const lines = emitted.filter((l) => {
    const k = l.slice(0, l.indexOf("="));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // The block itself → stdout (pipe to pbcopy).
  process.stdout.write(lines.join("\n") + "\n");

  // Diagnostics → stderr (won't pollute the clipboard).
  if (missing.length) {
    console.error(
      `\n[print-routine-env] ${lines.length} keys emitted. ` +
        `Not found in .env.local (skipped): ${missing.join(", ")}.\n` +
        `Integration creds (Appstle/EasyPost/etc.) are mostly per-workspace ` +
        `encrypted in the DB — the Routine reads them via ENCRYPTION_KEY, so ` +
        `their absence here is expected. Add any genuinely-missing global key ` +
        `to .env.local and rerun.`,
    );
  } else {
    console.error(`\n[print-routine-env] ${lines.length} keys emitted.`);
  }
}

main();
