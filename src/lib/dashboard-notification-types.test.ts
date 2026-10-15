/**
 * Pins `dashboard_notifications.type` writers to the `dashboard_notifications_type_check` CHECK.
 *
 * Incident: 2026-09-28 → 2026-10-14 production logged 6x `new row for relation
 * "dashboard_notifications" violates check constraint "dashboard_notifications_type_check"` at the
 * 09:00 UTC internal-subscription-renewal cron — its stranded-dunning + duplicate-renewal detectors
 * wrote `type='billing_alert'`, which the CHECK never listed, so every billing alert was lost.
 *
 * Three guards:
 *   1. DASHBOARD_NOTIFICATION_TYPES == the CHECK list in the NEWEST migration that re-creates it.
 *   2. Every `type:` passed to `.from("dashboard_notifications").insert/upsert(...)` in src/ +
 *      scripts/ (string literal, or an identifier bound to a string literal in the same file /
 *      the shared inbox constants) is a member of the list.
 *   3. Inserts whose payload is a variable / builder call are named in VARIABLE_PAYLOAD_SITES with
 *      the type their builder emits — a NEW variable-payload insert fails until it is reviewed.
 *
 * Run: npx tsx --test src/lib/dashboard-notification-types.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { DASHBOARD_NOTIFICATION_TYPES, isDashboardNotificationType } from "./dashboard-notification-types";

const REPO_ROOT = join(__dirname, "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** Cross-file constants callers pass as `type:` (resolved by name). */
const KNOWN_CONSTANTS: Record<string, string> = {
  APPROVAL_REQUEST_TYPE: "agent_approval_request",
  DAILY_SUMMARY_TYPE: "agent_daily_summary",
};

/**
 * Inserts whose payload is not an inline object literal — `file → type(s) the builder emits`.
 * Reviewed by hand; add a row (after checking the builder) when you add such an insert.
 */
const VARIABLE_PAYLOAD_SITES: Record<string, string[]> = {
  "src/lib/agents/approval-inbox.ts": ["agent_approval_request"], // buildApprovalNotification
  "src/lib/agents/platform-director.ts": ["agent_approval_request"], // escalationLoopCard / ceoEscalationNotification
  "scripts/reconcile-swallowed-escalations.ts": ["agent_approval_request"], // notifPayload
};

function latestCheckList(): { file: string; types: string[] } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIGRATIONS_DIR, files[i]), "utf8");
    const m = sql.match(
      /ADD\s+CONSTRAINT\s+dashboard_notifications_type_check\s+CHECK\s*\(([\s\S]*?)\)\s*;/i,
    );
    if (!m) continue;
    const types = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    return { file: files[i], types };
  }
  throw new Error("no migration defines dashboard_notifications_type_check");
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Return the text between the `(` at `open` and its matching `)`; strings/templates skipped. */
function balancedArg(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** `type:` values at the payload's top-level object(s) — nested `metadata: { type }` ignored. */
function topLevelTypeValues(arg: string): string[] {
  const trimmed = arg.trimStart();
  const rowDepth = trimmed.startsWith("[") ? 2 : 1;
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < arg.length && arg[i] !== q; i++) if (arg[i] === "\\") i++;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (depth === rowDepth && /[\s,{]/.test(arg[i - 1] ?? "") && arg.startsWith("type", i)) {
      const m = arg.slice(i).match(/^type\s*:\s*(["'`][^"'`]*["'`]|[A-Za-z_$][\w$.]*)/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  raw: string | null; // null ⇒ variable payload
}

function collectSites(): Site[] {
  const files = [...walk(join(REPO_ROOT, "src"), []), ...walk(join(REPO_ROOT, "scripts"), [])];
  const sites: Site[] = [];
  const re = /from\(\s*["'`]dashboard_notifications["'`]\s*\)\s*\.\s*(insert|upsert)\s*\(/g;
  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    const file = relative(REPO_ROOT, abs);
    for (const m of src.matchAll(re)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const arg = balancedArg(src, open);
      const line = src.slice(0, m.index).split("\n").length;
      const trimmed = arg.trimStart();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        sites.push({ file, line, raw: null });
        continue;
      }
      const vals = topLevelTypeValues(arg);
      // An inline object with no top-level `type` (unless it spreads a base row) is a NOT NULL
      // violation waiting to happen — flag it (2026-10-15: reseller-discovery passed `kind:`).
      if (vals.length === 0) sites.push({ file, line, raw: /\.\.\./.test(arg) ? null : "<missing>" });
      for (const v of vals) sites.push({ file, line, raw: v });
    }
  }
  return sites;
}

function resolveValue(file: string, raw: string): string | null {
  if (raw === "<missing>") return null;
  if (/^["'`]/.test(raw)) return raw.slice(1, -1);
  if (KNOWN_CONSTANTS[raw]) return KNOWN_CONSTANTS[raw];
  const src = readFileSync(join(REPO_ROOT, file), "utf8");
  const m = src.match(new RegExp(`const\\s+${raw.replace(/[$.]/g, "\\$&")}\\b[^=]*=\\s*["'\`]([a-z0-9_]+)["'\`]`));
  return m ? m[1] : null;
}

test("DASHBOARD_NOTIFICATION_TYPES matches the newest dashboard_notifications_type_check migration", () => {
  const { file, types } = latestCheckList();
  assert.ok(types.length > 0, `parsed no types from ${file}`);
  assert.deepEqual(
    [...types].sort(),
    [...DASHBOARD_NOTIFICATION_TYPES].sort(),
    `src/lib/dashboard-notification-types.ts drifted from ${file}`,
  );
});

test("the CHECK list includes the incident type + every previously allowed type (additive only)", () => {
  const { types } = latestCheckList();
  for (const t of [
    "macro_suggestion", "pattern_review", "knowledge_gap", "system", "fraud_alert", "chargeback_alert",
    "duplicate_order_alert", "escalation_gap", "agent_approval_request", "agent_message",
    "agent_daily_summary", "return_request", "mario_accuracy_alarm", "refund_drift", "fulfillment_alert",
    "billing_alert", "box_account_auth_expired",
  ]) {
    assert.ok(types.includes(t), `CHECK dropped / is missing '${t}'`);
  }
});

test("every dashboard_notifications insert/upsert passes a type the CHECK allows", () => {
  const sites = collectSites();
  assert.ok(sites.length > 50, `scanner found only ${sites.length} insert sites — regex broke?`);
  const bad: string[] = [];
  for (const s of sites) {
    if (s.raw === null) {
      const declared = VARIABLE_PAYLOAD_SITES[s.file];
      if (!declared) bad.push(`${s.file}:${s.line} — variable payload not reviewed (add to VARIABLE_PAYLOAD_SITES)`);
      else for (const t of declared) if (!isDashboardNotificationType(t)) bad.push(`${s.file}:${s.line} — '${t}'`);
      continue;
    }
    const v = resolveValue(s.file, s.raw);
    if (v === null) bad.push(`${s.file}:${s.line} — could not resolve type ${s.raw}`);
    else if (!isDashboardNotificationType(v)) bad.push(`${s.file}:${s.line} — '${v}' is not in dashboard_notifications_type_check`);
  }
  assert.deepEqual(bad, []);
});

test("scanner: nested metadata.type is ignored, top-level type is read", () => {
  assert.deepEqual(topLevelTypeValues(` { workspace_id: w, type: "system", metadata: { type: "return_sweep_no_order" } }`), ['"system"']);
  assert.deepEqual(topLevelTypeValues(` [{ type: X, title: "a" }, { type: 'fraud_alert' }]`), ["X", "'fraud_alert'"]);
  assert.deepEqual(topLevelTypeValues(` { entity_type: "fraud_case", title: "t" }`), []);
});

test("isDashboardNotificationType", () => {
  assert.equal(isDashboardNotificationType("billing_alert"), true);
  assert.equal(isDashboardNotificationType("agent_review_request"), false);
  assert.equal(isDashboardNotificationType(undefined), false);
});
