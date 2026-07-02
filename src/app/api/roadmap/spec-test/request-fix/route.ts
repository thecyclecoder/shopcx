/**
 * POST /api/roadmap/spec-test/request-fix — Request-a-fix INLINE from the spec-test card
 * (spec-test-request-fix-inline-author-and-approve Phase 1).
 *
 * The owner clicks Request a fix on the spec-test surface for a spec whose latest run is
 * `agent_verdict='issues'` with ≥1 failing check. Instead of routing them out to feature-chat
 * (the legacy `propose_fix` action on /api/roadmap/chat which seeds a `roadmap_chats` row +
 * enqueues a spec-chat turn), this handler authors the fix SPEC directly via the specs-table SDK
 * and enqueues its BUILD job — so the owner stays on the spec-test card while the fix builds and
 * lands an inline Approve affordance there (Phase 2 + 3).
 *
 *   { slug } → { fixSlug, alreadyAuthored, buildQueued, alreadyQueuedBuild }
 *
 * Owner-gated + workspace-scoped. The fix slug is deterministic on (origin, failing-check set) so
 * a re-click converges on the SAME spec row and the SAME single build job — second click NEVER
 * stacks a second build (dedup against any existing `kind='build'` row for the fix slug).
 *
 * This handler does NOT create a `roadmap_chats` row and does NOT enqueue a `kind='spec-chat'`
 * job — the whole point of the inline path is to skip the feature-chat round-trip. The legacy
 * `propose_fix` action on /api/roadmap/chat stays available for the regressions page caller.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLatestSpecTestRuns, checkKey } from "@/lib/spec-test-runs";
import { getSpec } from "@/lib/specs-table";
import { authorSpecRowStructured, MissingVerificationError } from "@/lib/author-spec";
import { markSpecCardForReview } from "@/lib/spec-card-state";

const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]+$/i.test(s);

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can request a fix" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

/** Deterministic fix slug = `fix-<origin>-<6hex of failing-check-key set>`. Same origin + same set of
 *  failing checks → same slug → upsert/build dedup converge. A genuinely new failing check on the same
 *  origin → different hash → a new fix spec (a new break gets its own review). Capped to keep the slug
 *  addressable as a kebab spec. */
function buildFixSlug(originSlug: string, failingKeys: string[]): string {
  const keys = [...new Set(failingKeys.map((k) => String(k || "").trim()).filter(Boolean))].sort();
  const hash = createHash("sha1").update(keys.join("|")).digest("hex").slice(0, 6);
  // Trim origin so the full slug stays under 100 chars (fix- + - + 6 = 11 overhead → 89 budget).
  const trimmedOrigin = originSlug.length > 80 ? originSlug.slice(0, 80) : originSlug;
  return `fix-${trimmedOrigin}-${hash}`;
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as { slug?: string };
  if (!isSlug(body.slug)) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const originSlug = body.slug;

  // 1. The trigger gate — only a spec whose latest spec-test is `issues` with ≥1 failing check qualifies.
  //    Mirrors the legacy `propose_fix` action's precondition.
  const runs = await getLatestSpecTestRuns(workspaceId);
  const run = runs[originSlug];
  const failing = (run?.checks ?? []).filter((c) => c.verdict === "fail");
  if (!run || run.agent_verdict !== "issues" || failing.length === 0) {
    return NextResponse.json(
      { error: "no regression to fix — the latest spec-test has no failing checks" },
      { status: 400 },
    );
  }

  // 2. Origin context — title + parent (the fix inherits the origin's mandate/goal placement so it lands
  //    under the same supervisor on the roadmap). Owner is always platform (the autonomous-build mandate).
  const origin = await getSpec(workspaceId, originSlug);
  if (!origin) return NextResponse.json({ error: `origin spec ${originSlug} not found` }, { status: 404 });

  const failingKeys = failing.map((c) => checkKey(c.text));
  const fixSlug = buildFixSlug(originSlug, failingKeys);

  // 3. Author the fix spec — UPSERT semantics keep a re-click idempotent on the spec side too (the same
  //    deterministic slug + same content → no material change). `regression_of_slug` is what
  //    retestOriginIfFixMerged reads after the fix's build merges to re-test the origin (closing the loop).
  const checkKeysJoined = failingKeys.join(", ");
  const phaseBody = [
    `The shipped spec [[${originSlug}]] FAILED its own \`## Verification\` when the box spec-test QA agent last`,
    `ran it — ${failing.length} previously-passing check${failing.length === 1 ? "" : "s"} now fail${failing.length === 1 ? "s" : ""}.`,
    "",
    `**Regression-of:** [[${originSlug}]]`,
    `**Fixes:** ${originSlug} (check ${checkKeysJoined})`,
    "",
    "Failing checks observed on the origin:",
    ...failing.map((c, i) => `${i + 1}. [check ${failingKeys[i]}] ${c.text}${c.evidence ? `\n   evidence: ${c.evidence}` : ""}`),
    "",
    "Investigate each failure against the origin spec + the brain + the code, then land the smallest",
    "change that makes every failing check pass again without regressing other shipped behaviour.",
  ].join("\n");

  const verification = [
    `- After this fix ships, re-running the box spec-test on [[${originSlug}]] → expect every previously-failing`,
    `  check to flip to \`pass\` (none of these check keys re-appear under \`verdict='fail'\` on the next`,
    `  \`spec_test_runs\` row for the origin):`,
    ...failing.map((c, i) => `  ${i + 1}. [check ${failingKeys[i]}] ${c.text}`),
    `- On the origin's [[${originSlug}]] card → expect its \`agent_verdict\` to leave \`issues\` (becomes`,
    `  \`approved\` or \`needs_human\`) once the fix lands and the next spec-test runs.`,
  ].join("\n");

  const title = `Fix: ${origin.title}`.slice(0, 200);
  const summary = `Regression fix for [[${originSlug}]] — restore the ${failing.length} failing \`## Verification\` check${failing.length === 1 ? "" : "s"} the box QA agent recorded on the last spec-test run.`;

  let authored: boolean;
  try {
    // pm-structured-intent-and-refs Phase 1 — plain-language intent for the auto-authored regression fix.
    // A request-fix has a deterministic why (previously-passing checks now fail on the shipped origin) and
    // what (the checks re-flip to pass on the next spec-test run), so hardcode both.
    const specWhy =
      `The shipped spec [[${originSlug}]] FAILED its own \`## Verification\` when the box spec-test QA agent ` +
      `last ran it — ${failing.length} previously-passing check${failing.length === 1 ? "" : "s"} now ` +
      `fail${failing.length === 1 ? "s" : ""}. Without this fix the origin sits with an active regression.`;
    const specWhat =
      `When this fix ships, the ${failing.length} failing verification check${failing.length === 1 ? "" : "s"} ` +
      `re-flip to pass on the origin's next spec-test run, and the origin's \`agent_verdict\` leaves \`issues\`.`;
    authored = await authorSpecRowStructured(
      workspaceId,
      fixSlug,
      {
        title,
        summary,
        owner: "platform",
        parent: origin.parent,
        blocked_by: [],
        critical: false,
        autoBuild: false,
        why: specWhy,
        what: specWhat,
        phases: [
          {
            title: `Fix the regression on ${originSlug}`,
            body: phaseBody,
            verification,
            status: "planned",
            why: specWhy,
            what: specWhat,
          },
        ],
      },
      "planned",
      {
        intendedStatusSetBy: "spec-test:request-fix-inline",
        regressionOfSlug: originSlug,
      },
    );
  } catch (e) {
    if (e instanceof MissingVerificationError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not author fix spec" },
      { status: 500 },
    );
  }
  if (!authored) {
    return NextResponse.json({ error: "could not author fix spec (DB write failed)" }, { status: 500 });
  }

  // Mirror the card-state marker every other authoring surface (planner, regression agent,
  // db-health, coverage-register) sets — keeps the in_review surfaces consistent.
  await markSpecCardForReview(workspaceId, fixSlug, "planned", {
    actor: "spec-test:request-fix-inline",
    reason: `Inline request-fix from spec-test card for ${originSlug}`,
  });

  // Did this slug already exist before this call? (For the caller's UI — Phase 2 reads this.) Detected by
  // looking for ANY agent_jobs build row already keyed to the slug.
  const { data: existingBuild } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", fixSlug)
    .eq("kind", "build")
    .limit(1)
    .maybeSingle();

  // 4. Enqueue the build — idempotent against ANY existing build row for this fix slug (live or terminal).
  //    A second click → existingBuild is set → skip the insert; the verification expects exactly ONE
  //    `kind='build'` row per fix slug after repeated clicks.
  if (existingBuild) {
    return NextResponse.json({
      fixSlug,
      alreadyAuthored: true,
      buildQueued: false,
      alreadyQueuedBuild: true,
    });
  }

  const { error: insertErr } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: fixSlug,
    kind: "build",
    status: "queued",
    created_by: user.id,
    instructions: `Build the inline-requested regression fix for ${originSlug}. Follow the spec exactly; tsc-clean; open a PR.`,
  });
  if (insertErr) {
    return NextResponse.json({ error: `could not queue build: ${insertErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    fixSlug,
    alreadyAuthored: false,
    buildQueued: true,
    alreadyQueuedBuild: false,
  });
}
