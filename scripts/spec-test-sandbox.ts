// spec-test-sandbox — the controlled-trigger toolkit for the box spec-test agent's SANDBOXED behavioral
// verification (spec-test-deep-verification Phase 2). The companion to scripts/spec-test-db-probe.ts
// (read-only DB) and scripts/spec-test-browser-check.ts (read-only browser): this gives the *behavioral*
// power — drive a flow on the test fixtures, assert the resulting DB rows + events, prove isolation, and
// clean up — ALL scoped to the dedicated `is_test` workspace.
//
// 🚨 EXTERNAL SIDE-EFFECT FIREWALL. It will ONLY drive a flow registered in INTERNAL_ONLY_FLOWS
// (src/lib/spec-test-sandbox.ts) — flows proven to keep every side effect internal (DB write / event).
// A flow that would call an external API with real effect (Amplifier, Braintree, Appstle, Resend,
// Twilio, Meta, …) is NOT runnable here; it stays needs_human. Every mutation/trigger is gated on
// assertTestWorkspace() — it is impossible to point this at a real tenant. The is_test workspace also
// carries NO external credentials (defense in depth).
//
// Usage (from the spec-test skill):
//   npx tsx scripts/spec-test-sandbox.ts info
//   npx tsx scripts/spec-test-sandbox.ts isolation
//   npx tsx scripts/spec-test-sandbox.ts fire comp-renewal-failclosed
//   npx tsx scripts/spec-test-sandbox.ts post human-queue-resolve [--clear]
//   npx tsx scripts/spec-test-sandbox.ts post <flowId> --body '{"...":"..."}'
//   npx tsx scripts/spec-test-sandbox.ts cleanup
//
// Prints a JSON verdict to stdout. NEVER touches a non-test workspace.
import { createAdminClient, pgClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import {
  SPEC_TEST_FIXTURES,
  INTERNAL_ONLY_FLOWS,
  EXTERNAL_EDGE_EXAMPLES,
  EXTERNAL_SIDE_EFFECT_APIS,
  getSandboxFlow,
  assertTestWorkspace,
  nonTestWorkspaceFingerprint,
  diffFingerprints,
  mintOwnerCookieHeader,
  type IsolationFingerprint,
} from "../src/lib/spec-test-sandbox";
import { checkKey } from "../src/lib/spec-test-runs";

const F = SPEC_TEST_FIXTURES;
const BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").replace(/\/$/, "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

// Read-only isolation fingerprint over a fresh pg connection.
async function fingerprint(): Promise<IsolationFingerprint> {
  const c = pgClient();
  await c.connect();
  try {
    await c.query("begin transaction read only");
    const fp = await nonTestWorkspaceFingerprint(async (sql) => {
      const res = await c.query(sql);
      return { rows: res.rows };
    });
    await c.query("rollback");
    return fp;
  } finally {
    await c.end();
  }
}

// ─── info ───────────────────────────────────────────────────────────────────────────────────────────
async function cmdInfo(): Promise<void> {
  out({
    fixtures: F,
    internal_only_flows: INTERNAL_ONLY_FLOWS,
    external_edge_examples_NOT_runnable: EXTERNAL_EDGE_EXAMPLES,
    external_side_effect_apis_forbidden: EXTERNAL_SIDE_EFFECT_APIS,
  });
}

// ─── isolation ───────────────────────────────────────────────────────────────────────────────────────
async function cmdIsolation(): Promise<void> {
  out({ test_workspace: F.workspaceId, non_test_workspace_fingerprint: await fingerprint() });
}

// ─── fire comp-renewal-failclosed ────────────────────────────────────────────────────────────────────
async function cmdFire(flowId: string): Promise<void> {
  const flow = getSandboxFlow(flowId);
  if (!flow || flow.trigger.kind !== "event") {
    throw new Error(`fire: '${flowId}' is not a registered internal-only EVENT flow. Run \`info\` for the list.`);
  }
  const admin = createAdminClient();
  await assertTestWorkspace(admin, F.workspaceId); // firewall: only the is_test tenant

  if (flowId !== "comp-renewal-failclosed") {
    throw new Error(`fire: no driver implemented for '${flowId}' (registered but not wired).`);
  }

  // ── Prove the internal-only branch precondition (comp sub, customer NOT allowlisted) ──────────────
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, workspace_id, customer_id, comp, is_internal, status, next_billing_date")
    .eq("id", F.subscriptionCompId)
    .maybeSingle();
  if (!sub) throw new Error(`fire: fixture sub ${F.subscriptionCompId} not found — run seed-spec-test-fixtures.ts first.`);
  if (sub.workspace_id !== F.workspaceId) throw new Error(`fire: fixture sub is not in the is_test workspace.`);
  const { data: cust } = await admin
    .from("customers")
    .select("id, comp_role")
    .eq("id", sub.customer_id as string)
    .maybeSingle();
  if (!sub.comp || !sub.is_internal || sub.status !== "active") {
    throw new Error(`fire: sub is not an active comp/internal sub — cannot guarantee the internal-only branch.`);
  }
  if (cust?.comp_role) {
    // A valid comp_role would take the HAPPY path → Amplifier handoff (external). FIREWALL: refuse.
    throw new Error(
      `fire: customer.comp_role='${cust.comp_role}' would take the comp HAPPY path (Amplifier handoff = external). ` +
        `Refusing — that flow is needs_human. Reset comp_role to null (re-run the seed) to drive the fail-closed branch.`,
    );
  }

  const beforeBilling = sub.next_billing_date as string | null;
  const before = await fingerprint();
  const firedAt = new Date(Date.now() - 2000).toISOString(); // small skew cushion

  // ── Fire the real Inngest event (the prod handler takes the fail-closed branch by precondition) ───
  const { Inngest } = await import("inngest");
  const inngest = new Inngest({ id: "shopcx", eventKey: process.env.INNGEST_EVENT_KEY });
  const send = await inngest.send({
    name: flow.trigger.name,
    data: { subscription_id: F.subscriptionCompId, workspace_id: F.workspaceId },
  });

  // ── Poll for the expected internal artifacts ──────────────────────────────────────────────────────
  let failedTxn: Record<string, unknown> | null = null;
  let failEvent: Record<string, unknown> | null = null;
  let order: Record<string, unknown> | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const { data: txns } = await admin
      .from("transactions")
      .select("id, type, status, amount_cents, created_at")
      .eq("subscription_id", F.subscriptionCompId)
      .eq("type", "comp")
      .eq("status", "failed")
      .gte("created_at", firedAt)
      .order("created_at", { ascending: false })
      .limit(1);
    failedTxn = txns?.[0] ?? null;
    const { data: evs } = await admin
      .from("customer_events")
      .select("id, event_type, created_at")
      .eq("workspace_id", F.workspaceId)
      .eq("event_type", "subscription.comp_renewal_failed")
      .gte("created_at", firedAt)
      .order("created_at", { ascending: false })
      .limit(1);
    failEvent = evs?.[0] ?? null;
    if (failedTxn && failEvent) break;
  }
  // Negative assertion: NO order created for this sub by the run.
  const { data: orders } = await admin
    .from("orders")
    .select("id, created_at")
    .eq("subscription_id", F.subscriptionCompId)
    .gte("created_at", firedAt)
    .limit(1);
  order = orders?.[0] ?? null;

  // Billing date not advanced.
  const { data: subAfter } = await admin
    .from("subscriptions")
    .select("next_billing_date")
    .eq("id", F.subscriptionCompId)
    .maybeSingle();
  const billingUnchanged = (subAfter?.next_billing_date ?? null) === beforeBilling;

  const after = await fingerprint();
  const isolationChanged = diffFingerprints(before, after);

  const pass =
    !!failedTxn && !!failEvent && !order && billingUnchanged && isolationChanged.length === 0;
  out({
    flow: flowId,
    pass,
    event_sent: send,
    asserts: {
      failed_comp_transaction: !!failedTxn,
      comp_renewal_failed_event: !!failEvent,
      no_order_created: !order,
      billing_date_not_advanced: billingUnchanged,
    },
    isolation: {
      zero_non_test_workspace_writes: isolationChanged.length === 0,
      tables_changed: isolationChanged,
    },
    evidence: { failedTxn, failEvent, order },
  });
  if (!pass) process.exit(2);
}

// ─── post <flowId> ───────────────────────────────────────────────────────────────────────────────────
function parsePostArgs(argv: string[]): { body?: string; clear: boolean } {
  let body: string | undefined;
  let clear = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--body") body = argv[++i];
    else if (argv[i] === "--clear") clear = true;
  }
  return { body, clear };
}

async function cmdPost(flowId: string, rest: string[]): Promise<void> {
  const flow = getSandboxFlow(flowId);
  if (!flow || flow.trigger.kind !== "post") {
    throw new Error(`post: '${flowId}' is not a registered internal-only POST flow. Run \`info\` for the list.`);
  }
  const admin = createAdminClient();
  await assertTestWorkspace(admin, F.workspaceId); // firewall: only the is_test tenant

  const { body: bodyArg, clear } = parsePostArgs(rest);
  let body: Record<string, unknown>;
  if (bodyArg) {
    body = JSON.parse(bodyArg);
  } else if (flowId === "human-queue-resolve") {
    // Default runnable body — mark (or clear) a sandbox check on this spec.
    const checkText = "spec-test sandbox fixture check";
    const slug = "spec-test-deep-verification";
    body = clear
      ? { slug, check_key: checkKey(checkText), clear: true }
      : { slug, check_key: checkKey(checkText), check_text: checkText, resolution: "verified" };
  } else {
    throw new Error(`post: '${flowId}' needs an explicit --body '<json>' (e.g. roadmap-answer needs { jobId, answers }).`);
  }

  const cookie = await mintOwnerCookieHeader(F.workspaceId);
  const res = await fetch(`${BASE_URL}${flow.trigger.endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 500); }
  const pass = res.ok;
  out({ flow: flowId, endpoint: flow.trigger.endpoint, httpStatus: res.status, pass, request_body: body, response: json });
  if (!pass) process.exit(2);
}

// ─── cleanup (idempotent) ─────────────────────────────────────────────────────────────────────────────
async function cmdCleanup(): Promise<void> {
  const admin = createAdminClient();
  await assertTestWorkspace(admin, F.workspaceId); // firewall: only delete inside the is_test tenant

  const deleted: Record<string, number | string> = {};
  // Transient run artifacts scoped to the test sub / workspace.
  for (const table of ["transactions", "orders"] as const) {
    const { count, error } = await admin
      .from(table)
      .delete({ count: "exact" })
      .eq("workspace_id", F.workspaceId)
      .eq("subscription_id", F.subscriptionCompId);
    deleted[table] = error ? `error: ${error.message}` : count ?? 0;
  }
  {
    const { count, error } = await admin
      .from("customer_events")
      .delete({ count: "exact" })
      .eq("workspace_id", F.workspaceId)
      .in("event_type", ["subscription.comp_renewal_failed", "subscription.comp_shipped", "subscription.payment_failed"]);
    deleted["customer_events"] = error ? `error: ${error.message}` : count ?? 0;
  }
  {
    // Owner human-check resolutions written for the is_test workspace by the post flow.
    const { count, error } = await admin
      .from("spec_test_human_checks")
      .delete({ count: "exact" })
      .eq("workspace_id", F.workspaceId)
      .eq("spec_slug", "spec-test-deep-verification");
    deleted["spec_test_human_checks"] = error ? `error: ${error.message}` : count ?? 0;
  }
  // Reset the comp sub to baseline (active, due today) so the next fail-closed run asserts cleanly.
  const nextBilling = new Date();
  nextBilling.setUTCHours(0, 0, 0, 0);
  await admin
    .from("subscriptions")
    .update({ status: "active", comp: true, next_billing_date: nextBilling.toISOString() })
    .eq("id", F.subscriptionCompId);
  await admin.from("customers").update({ comp_role: null }).eq("id", F.customerFailClosedId);

  out({ cleaned: true, deleted, reset: { subscription: F.subscriptionCompId, customer_comp_role: null } });
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "info": return cmdInfo();
    case "isolation": return cmdIsolation();
    case "fire": if (!arg) throw new Error("fire <flowId>"); return cmdFire(arg);
    case "post": if (!arg) throw new Error("post <flowId>"); return cmdPost(arg, rest);
    case "cleanup": return cmdCleanup();
    default:
      console.error(
        "usage: npx tsx scripts/spec-test-sandbox.ts <info|isolation|fire <flowId>|post <flowId> [--body json|--clear]|cleanup>",
      );
      process.exit(1);
  }
}
main().catch((e) => {
  console.error(JSON.stringify({ pass: false, error: errText(e) }));
  process.exit(1);
});
