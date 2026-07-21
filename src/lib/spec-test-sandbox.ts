/**
 * spec-test-sandbox — the shared core for the box spec-test agent's SANDBOXED behavioral verification
 * (spec-test-deep-verification Phase 2). It is the contract between three callers:
 *   - `scripts/seed-spec-test-fixtures.ts` (the GATED owner-approved seed) — uses {@link SPEC_TEST_FIXTURES}
 *     to create the dedicated `is_test` workspace + test customer / subscription / ticket / migration_audit.
 *   - `scripts/spec-test-sandbox.ts` (the controlled-trigger CLI) — fires Inngest events / calls internal
 *     POST endpoints / reads back rows to assert / cleans up, ALL scoped to the `is_test` workspace.
 *   - the `spec-test` skill + `runSpecTestJob` prompt — classify a behavioral bullet as a SANDBOX check.
 *
 * 🚨 EXTERNAL SIDE-EFFECT FIREWALL (the core safety rule). A flow is driven in the sandbox ONLY if every
 * side effect stays INTERNAL (a DB write or an Inngest event). A flow that would call an EXTERNAL API
 * with a real effect — Amplifier fulfillment, a Braintree charge/refund, an Appstle mutation, a
 * Resend/Twilio send, a live Meta ad pause — is NOT run; it is classified `needs_human`. Only the flows
 * in {@link INTERNAL_ONLY_FLOWS} are runnable, and each declares the fixture precondition that GUARANTEES
 * its internal-only branch. The comp-renewal HAPPY path is deliberately NOT registered (its Amplifier
 * handoff is external) — see {@link EXTERNAL_EDGE_EXAMPLES}; we assert up to the handoff and flag the
 * handoff itself human. Defense in depth: the `is_test` workspace carries NO external credentials, so
 * even a slipped external call cannot have a real effect (e.g. `createAmplifierOrder` returns
 * `{success:false, error:"amplifier_not_configured"}` with no network call).
 *
 * Read-only-on-real-data is preserved: nothing here can target a workspace where `is_test` is not true
 * ({@link assertTestWorkspace} is the hard guard), and the isolation fingerprint ({@link
 * nonTestWorkspaceFingerprint}) proves a sandbox run made ZERO writes to non-test-workspace rows.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { errText } from "@/lib/error-text";
import { createChunks, stringToBase64URL } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── Fixture identity (stable UUIDs so the seed is idempotent + the CLI can find fixtures) ───────────
// All fixture rows live under the ONE `is_test` workspace. The hex prefix `5ec77e57` ("spec-test"-ish)
// makes a fixture row obvious in any dump; the last byte distinguishes each row.
export const SPEC_TEST_FIXTURES = {
  /** The dedicated test tenant. `is_test=true`, NO external credentials. */
  workspaceId: "5ec77e57-0000-4000-8000-000000000001",
  workspaceName: "ShopCX Spec-Test Sandbox (is_test)",
  /** Owner email — added as an `owner` workspace_member so owner-gated endpoints pass when scoped here. */
  ownerEmail: (process.env.SPEC_TEST_OWNER_EMAIL || "dylan@superfoodscompany.com").toLowerCase(),
  /** Comp customer with NO comp_role → drives the comp-renewal FAIL-CLOSED (internal-only) branch. */
  customerFailClosedId: "5ec77e57-0000-4000-8000-000000000002",
  customerFailClosedEmail: "spec-test-failclosed@sandbox.shopcx.invalid",
  /** The comp subscription (comp=true, is_internal=true) the renewal-attempt fires against. */
  subscriptionCompId: "5ec77e57-0000-4000-8000-000000000003",
  /** A test ticket (for ticket-flow bullets). */
  ticketId: "5ec77e57-0000-4000-8000-000000000004",
  /** A test migration_audit row (for migration-flow bullets). */
  migrationAuditId: "5ec77e57-0000-4000-8000-000000000005",
} as const;

/** True iff a workspace id is the spec-test sandbox tenant. */
export function isSpecTestWorkspace(workspaceId: string | null | undefined): boolean {
  return workspaceId === SPEC_TEST_FIXTURES.workspaceId;
}

// ─── External side-effect catalogue (what the firewall forbids) ─────────────────────────────────────
export type ExternalApi =
  | "amplifier" | "braintree" | "appstle" | "resend" | "twilio" | "meta" | "avalara" | "easypost" | "shopify";

export const EXTERNAL_SIDE_EFFECT_APIS: Record<ExternalApi, string> = {
  amplifier: "Amplifier 3PL fulfillment — places a real shipment order.",
  braintree: "Braintree — charges / refunds / voids a real card.",
  appstle: "Appstle — mutates a live Shopify subscription contract.",
  resend: "Resend — sends a real email.",
  twilio: "Twilio — sends a real SMS / verify.",
  meta: "Meta Graph — pauses/edits a live ad, sends a DM, posts a comment.",
  avalara: "Avalara — commits/voids a real tax document.",
  easypost: "EasyPost — buys a real shipping label.",
  shopify: "Shopify Admin — mutates the live storefront / orders / customers.",
};

// ─── The internal-only flow registry (the ONLY flows the sandbox will drive) ────────────────────────
export type SandboxTrigger =
  | { kind: "event"; name: string }
  | { kind: "post"; endpoint: string; method?: "POST" };

export type SandboxFlow = {
  /** Stable id used on the CLI: `spec-test-sandbox fire <id>` / `post <id>`. */
  id: string;
  title: string;
  trigger: SandboxTrigger;
  /** Always true here — a flow is registered ONLY when proven internal-only. */
  internalOnly: true;
  /** Why every side effect of THIS branch stays internal (DB write / event). */
  rationale: string;
  /** The fixture state that GUARANTEES the internal-only branch is taken. */
  precondition: string;
  /** What to assert after driving it (rows / events). Plain English for the agent's evidence. */
  asserts: string[];
};

export const INTERNAL_ONLY_FLOWS: SandboxFlow[] = [
  {
    id: "comp-renewal-failclosed",
    title: "Comp renewal fail-closed (comp sub, customer has no valid comp_role)",
    trigger: { kind: "event", name: "internal-subscription/renewal-attempt" },
    internalOnly: true,
    rationale:
      "The comp branch GATES FIRST on the comp allowlist: a comp sub whose customer.comp_role is null/invalid " +
      "inserts a failed type='comp' transaction + a subscription.comp_renewal_failed customer_events row and " +
      "RETURNS — before any Amplifier/Braintree/Avalara call and before load-context (which requires a PM). " +
      "Every side effect is an internal DB write. See src/lib/inngest/internal-subscription-renewals.ts.",
    precondition:
      "The comp subscription (comp=true, is_internal=true, status='active') belongs to a customer whose " +
      "comp_role IS NULL — so the renewal takes the FAIL-CLOSED branch, never the shipping/Amplifier branch.",
    asserts: [
      "a transactions row type='comp' status='failed' amount_cents=0 for the sub appears",
      "a customer_events row event_type='subscription.comp_renewal_failed' appears",
      "NO order row is created and next_billing_date is NOT advanced",
    ],
  },
  {
    id: "human-queue-resolve",
    title: "Owner marks a spec-test check ✓ Tested (then re-open)",
    trigger: { kind: "post", endpoint: "/api/developer/spec-test/human-queue" },
    internalOnly: true,
    rationale:
      "Owner-gated POST that upserts the owner's own spec_test_human_checks row (and { clear:true } deletes " +
      "it). Workspace-scoped by the workspace_id cookie → scoped to the is_test workspace. DB write only.",
    precondition:
      "Called with owner cookies minted for the is_test workspace; body { slug, check_key=checkKey(check_text), " +
      "check_text, resolution:'verified' } then { slug, check_key, clear:true } to undo (idempotent).",
    asserts: [
      "POST returns { ok:true } and a spec_test_human_checks row is upserted for the is_test workspace",
      "the { clear:true } POST returns { clear:true } and removes the row (re-runnable)",
    ],
  },
  {
    id: "roadmap-answer",
    title: "Owner answers a build's open questions → job flips queued_resume",
    trigger: { kind: "post", endpoint: "/api/roadmap/answer" },
    internalOnly: true,
    rationale:
      "Owner-gated POST that writes the answers onto a kind='build' agent_jobs row and flips it to " +
      "queued_resume for the box worker. DB write only — no external API. Requires a fixture build job in " +
      "the is_test workspace (caller supplies its id).",
    precondition:
      "A kind='build' agent_jobs row in status='needs_input' on the is_test workspace exists; called with " +
      "owner cookies for the is_test workspace and body { jobId, answers:[{id,q,answer}] }.",
    asserts: [
      "POST returns { job } and the agent_jobs row status becomes 'queued_resume'",
    ],
  },
];

export function getSandboxFlow(id: string): SandboxFlow | undefined {
  return INTERNAL_ONLY_FLOWS.find((f) => f.id === id);
}

/**
 * Flows that LOOK sandbox-eligible but are NOT — they cross the external firewall. Documented so the
 * agent classifies them `needs_human` (or asserts up to the external edge and flags the edge human)
 * instead of driving them. NEVER add one of these to {@link INTERNAL_ONLY_FLOWS}.
 */
export const EXTERNAL_EDGE_EXAMPLES: Array<{
  id: string;
  title: string;
  blockedBy: ExternalApi[];
  note: string;
}> = [
  {
    id: "comp-renewal-happy",
    title: "Comp renewal HAPPY path (allowlisted comp customer → free shipment)",
    blockedBy: ["amplifier"],
    note:
      "The allowlisted branch creates the $0 order + type='comp' txn + advance (all internal — assertable) " +
      "BUT then hands off to Amplifier (createAmplifierOrder) for real fulfillment. The Amplifier handoff is " +
      "the external edge: assert up to it, flag the handoff itself needs_human. Do NOT drive this flow.",
  },
  {
    id: "renewal-charge",
    title: "Standard internal renewal (non-comp)",
    blockedBy: ["braintree", "avalara", "amplifier"],
    note: "Charges a real card via Braintree, commits Avalara tax, hands to Amplifier. Fully external — needs_human.",
  },
  {
    id: "refund / coupon / pause-ad / send-message",
    title: "Any flow issuing a refund, applying a real coupon, pausing a live Meta ad, or sending email/SMS",
    blockedBy: ["braintree", "shopify", "meta", "resend", "twilio"],
    note: "Real customer/$/external effect — never executed; stays needs_human.",
  },
];

// ─── The hard guard: only ever operate on the is_test workspace ─────────────────────────────────────
/**
 * Throws unless `workspaceId` is a workspace with `is_test=true`. Every sandbox mutation/trigger MUST
 * call this first — it is the firewall that makes pointing the toolkit at a real tenant impossible.
 */
export async function assertTestWorkspace(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<void> {
  if (workspaceId !== SPEC_TEST_FIXTURES.workspaceId) {
    throw new Error(
      `spec-test-sandbox: refusing to operate on ${workspaceId} — not the designated is_test workspace ` +
        `(${SPEC_TEST_FIXTURES.workspaceId}).`,
    );
  }
  const { data, error } = await admin
    .from("workspaces")
    .select("id, is_test")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`spec-test-sandbox: could not load workspace ${workspaceId}: ${error.message}`);
  if (!data) throw new Error(`spec-test-sandbox: workspace ${workspaceId} does not exist — run the fixture seed first.`);
  if (data.is_test !== true) {
    throw new Error(`spec-test-sandbox: workspace ${workspaceId} has is_test=false — refusing (firewall).`);
  }
}

// ─── Isolation fingerprint (proves a sandbox run wrote ZERO non-test-workspace rows) ─────────────────
/** Mutable tables a sandbox flow could conceivably touch — fingerprinted before/after a run. */
export const ISOLATION_TABLES = [
  "transactions",
  "orders",
  "customer_events",
  "subscriptions",
  "tickets",
  "spec_test_human_checks",
  "agent_jobs",
] as const;

export type IsolationFingerprint = Record<string, { count: number; maxUpdated: string | null }>;

/**
 * Count rows + newest `updated_at`/`created_at` per table for EVERYTHING that is NOT the is_test
 * workspace. Take it before and after a sandbox run; an unchanged fingerprint proves the run touched
 * only is_test rows. Uses a raw read-only SQL client (caller owns connect/end).
 */
export async function nonTestWorkspaceFingerprint(
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  testWorkspaceId: string = SPEC_TEST_FIXTURES.workspaceId,
): Promise<IsolationFingerprint> {
  const fp: IsolationFingerprint = {};
  for (const table of ISOLATION_TABLES) {
    // Prefer updated_at, fall back to created_at (some tables have only created_at).
    const tsCol = ["transactions", "subscriptions", "tickets", "agent_jobs"].includes(table)
      ? "updated_at"
      : "created_at";
    const sql =
      `select count(*)::int as n, max(${tsCol}) as ts from public.${table} ` +
      `where workspace_id <> '${testWorkspaceId}'`;
    try {
      const { rows } = await query(sql);
      const r = rows[0] || {};
      fp[table] = { count: Number(r.n ?? 0), maxUpdated: r.ts ? String(r.ts) : null };
    } catch (e) {
      fp[table] = { count: -1, maxUpdated: `error: ${errText(e)}` };
    }
  }
  return fp;
}

/** Compare two fingerprints — returns the list of tables that changed (empty = perfect isolation). */
export function diffFingerprints(before: IsolationFingerprint, after: IsolationFingerprint): string[] {
  const changed: string[] = [];
  for (const table of ISOLATION_TABLES) {
    const b = before[table];
    const a = after[table];
    if (!b || !a) continue;
    if (b.count !== a.count || b.maxUpdated !== a.maxUpdated) changed.push(table);
  }
  return changed;
}

// ─── Owner-cookie minting for internal POST endpoints (NO human creds) ──────────────────────────────
/** Supabase project ref from the URL host (sb-<ref>-auth-token is the default storage key). */
function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return new URL(url).hostname.split(".")[0];
}

/**
 * Mint an OWNER session server-side (service-role admin — NO password) and return a `Cookie:` header
 * string ready for `fetch`, scoped to `workspaceId` (the is_test workspace). Same mechanism as
 * scripts/spec-test-browser-check.ts: generateLink → verifyOtp → @supabase/ssr cookie encoding + the
 * `workspace_id` cookie the middleware gate requires.
 */
export async function mintOwnerCookieHeader(workspaceId: string): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  const admin = createAdminClient();

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: SPEC_TEST_FIXTURES.ownerEmail,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(`generateLink failed for ${SPEC_TEST_FIXTURES.ownerEmail}: ${linkErr?.message || "no hashed_token"}`);
  }
  const anon = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpErr || !otp?.session) throw new Error(`verifyOtp failed: ${otpErr?.message || "no session"}`);

  const storageKey = `sb-${projectRef()}-auth-token`;
  const cookieValue = "base64-" + stringToBase64URL(JSON.stringify(otp.session));
  const chunks = createChunks(storageKey, cookieValue);
  const parts = chunks.map((c) => `${c.name}=${c.value}`);
  parts.push(`workspace_id=${workspaceId}`);
  return parts.join("; ");
}

/** Resolve the owner's auth user id (via generateLink — no email sent) for membership seeding. */
export async function resolveOwnerUserId(): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: SPEC_TEST_FIXTURES.ownerEmail,
  });
  if (error || !data?.user?.id) return null;
  return data.user.id;
}
