/**
 * ad-review-feedback-router — Phase 2 of ceo-manual-ad-review-inline-per-element-feedback-
 * routed-to-dahlia-max-render. A pure planner + a chokepoint enqueuer that turn a persisted
 * `public.ad_review_feedback` packet into the concrete `agent_jobs` re-drives the spec calls
 * for: a copy-target comment → `ad-creative-copy-author` (revise the targeted variation with
 * the CEO comment); an image-target comment → `ad-creative` (regenerate the named format
 * with the note); a Max-target comment → `ad-creative-copy-qc` (re-QA with the correction
 * in context); then ONE final `ad-creative-copy-qc` whole-ad re-QA that lands the ad back
 * in the bin on pass.
 *
 * Split from the SDK ([[ad-review-feedback]]) so the router's shape can be unit-tested as
 * pure data (no DB) — the pipe from packet → job specs is the contract Phase 2's verification
 * pins ("a packet with one image + one copy + one max entry produces exactly the three
 * targeted re-drives plus the final re-QA, and untargeted elements produce no job").
 *
 * READ-ONLY router → the `enqueueAdReviewFeedback` helper is the ONLY writer, and it
 * gates every side effect on a compare-and-set status transition
 * (queued → processing → done) so a same-row double-dispatch produces zero duplicate jobs
 * (the spec's idempotency rule).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type {
  AdReviewFeedbackEntry,
  AdReviewFeedbackPacket,
  AdReviewFeedbackRow,
} from "./ad-review-feedback";

type Admin = ReturnType<typeof createAdminClient>;

/** Job kinds this router enqueues. Narrowed to the exact set the spec calls out so a future
 *  new target-kind is a two-line change (add to the union + add a switch arm) rather than an
 *  implicit `string` that any typo squeezes through. */
export type AdReviewRedriveKind =
  | "ad-creative-copy-author"
  | "ad-creative"
  | "ad-creative-copy-qc";

/** One planned re-drive — a spec for the `agent_jobs` row the enqueuer will insert. `entry`
 *  is `null` on the trailing whole-ad re-QA; on every other spec it points back at the
 *  originating packet entry so a reader can join a queued job to the exact CEO comment
 *  that drove it. */
export interface AdReviewRedriveSpec {
  kind: AdReviewRedriveKind;
  /** JSON-serializable instruction payload the receiving lane parses. Always carries
   *  `ad_review_feedback_id`, `ad_campaign_id`, and `revise_reason` so the receiving lane
   *  never has to look them up; kind-specific fields (`framework`, `format`) narrow the target. */
  instructions: Record<string, unknown>;
  /** The originating packet entry — `null` on the trailing whole-ad re-QA. */
  entry: AdReviewFeedbackEntry | null;
  /** Human-readable label — used by the log_tail / brain-page walkthroughs. */
  label: string;
}

/** Route a validated packet into the planned re-drives. Order:
 *  1. one spec per non-empty entry (in packet order, so the log is stable), then
 *  2. exactly ONE trailing whole-ad `ad-creative-copy-qc` re-QA.
 *
 *  Untargeted elements (empty comment boxes) don't reach this function — the packet parser
 *  ([[ad-review-feedback]] `parseAdReviewFeedbackPacket`) drops them at build time — so a
 *  filled-count of N produces exactly N + 1 specs and never `N + fixed-overhead`. */
export function routeAdReviewFeedback(
  packet: AdReviewFeedbackPacket,
  ctx: { adCampaignId: string; adReviewFeedbackId: string },
): AdReviewRedriveSpec[] {
  const specs: AdReviewRedriveSpec[] = [];
  for (const entry of packet.entries) {
    specs.push(specForEntry(entry, ctx));
  }
  specs.push(finalReQaSpec(ctx));
  return specs;
}

function specForEntry(
  entry: AdReviewFeedbackEntry,
  ctx: { adCampaignId: string; adReviewFeedbackId: string },
): AdReviewRedriveSpec {
  const base = {
    ad_review_feedback_id: ctx.adReviewFeedbackId,
    ad_campaign_id: ctx.adCampaignId,
    revise_reason: entry.comment,
  };
  switch (entry.targetKind) {
    case "copy-variation":
      return {
        kind: "ad-creative-copy-author",
        instructions: { ...base, targetKind: entry.targetKind, framework: entry.framework },
        entry,
        label: `revise copy variation "${entry.framework}" (ceo-review)`,
      };
    case "canonical-copy":
      return {
        kind: "ad-creative-copy-author",
        instructions: { ...base, targetKind: entry.targetKind },
        entry,
        label: "revise canonical copy (ceo-review)",
      };
    case "render-format":
      return {
        kind: "ad-creative",
        instructions: { ...base, targetKind: entry.targetKind, format: entry.format },
        entry,
        label: `regenerate render format "${entry.format}" (ceo-review)`,
      };
    case "max-grade":
      return {
        kind: "ad-creative-copy-qc",
        instructions: { ...base, targetKind: entry.targetKind, mode: "correction" },
        entry,
        label: "re-QA with CEO correction context (ceo-review)",
      };
  }
}

function finalReQaSpec(ctx: {
  adCampaignId: string;
  adReviewFeedbackId: string;
}): AdReviewRedriveSpec {
  return {
    kind: "ad-creative-copy-qc",
    instructions: {
      ad_review_feedback_id: ctx.adReviewFeedbackId,
      ad_campaign_id: ctx.adCampaignId,
      mode: "final-re-qa",
    },
    entry: null,
    label: "final whole-ad Max re-QA (ceo-review)",
  };
}

/** Compare-and-set status transition on `public.ad_review_feedback`. Returns true iff exactly
 *  one row transitioned (matching workspace_id + id + expected status). The mutating callers
 *  in this file gate every side effect on this returning true so a same-row double-dispatch
 *  never queues a second round of re-drives. */
export async function transitionAdReviewFeedbackStatus(
  admin: Admin,
  opts: {
    workspaceId: string;
    id: string;
    from: AdReviewFeedbackRow["status"];
    to: AdReviewFeedbackRow["status"];
  },
): Promise<boolean> {
  const { data, error } = await admin
    .from("ad_review_feedback")
    .update({ status: opts.to })
    .eq("workspace_id", opts.workspaceId)
    .eq("id", opts.id)
    .eq("status", opts.from)
    .select("id");
  if (error) {
    throw new Error(
      `transitionAdReviewFeedbackStatus: ${opts.from}->${opts.to} failed for id=${opts.id}: ${error.message}`,
    );
  }
  return (data ?? []).length === 1;
}

export interface EnqueueAdReviewFeedbackResult {
  /** True if the row transitioned queued → processing → done and specs were enqueued.
   *  False if the row was NOT queued (already processing / done / failed) — the caller
   *  reads this to distinguish "did work" vs "no-op idempotent skip". */
  dispatched: boolean;
  /** The specs the router produced (empty when `dispatched` is false). */
  specs: AdReviewRedriveSpec[];
  /** The agent_jobs.ids that were inserted, in the same order as `specs`. */
  jobIds: string[];
}

/** Read the feedback row, plan the re-drives, insert one agent_jobs row per spec, and flip
 *  status queued → processing → done — but ONLY when the row is currently `queued`. A row
 *  in any other status is a no-op (returns `{dispatched:false, specs:[], jobIds:[]}`) so the
 *  worker's claim loop can safely re-invoke without producing duplicate work. Compare-and-set
 *  guards the transition; a driver error on the agent_jobs insert flips the row to `failed`
 *  before rethrowing so the row can't sit `processing` forever after a partial dispatch. */
export async function enqueueAdReviewFeedback(
  admin: Admin,
  opts: { workspaceId: string; adReviewFeedbackId: string; specSlug?: string },
): Promise<EnqueueAdReviewFeedbackResult> {
  const { workspaceId, adReviewFeedbackId } = opts;

  // Read the row + assert it's queued. If it's not queued we're a no-op — this is the
  // idempotency backstop even before the compare-and-set below (which handles the race).
  const { data: row, error: readErr } = await admin
    .from("ad_review_feedback")
    .select("id, workspace_id, ad_campaign_id, packet, status, created_by, created_at")
    .eq("workspace_id", workspaceId)
    .eq("id", adReviewFeedbackId)
    .single();
  if (readErr || !row) {
    throw new Error(
      `enqueueAdReviewFeedback: could not read ad_review_feedback id=${adReviewFeedbackId}: ${readErr?.message ?? "no row"}`,
    );
  }
  const feedback = row as AdReviewFeedbackRow;
  if (feedback.status !== "queued") {
    return { dispatched: false, specs: [], jobIds: [] };
  }

  const claimed = await transitionAdReviewFeedbackStatus(admin, {
    workspaceId,
    id: adReviewFeedbackId,
    from: "queued",
    to: "processing",
  });
  if (!claimed) {
    // Another lane won the race — a no-op is the correct behavior (never duplicate work).
    return { dispatched: false, specs: [], jobIds: [] };
  }

  const specs = routeAdReviewFeedback(feedback.packet, {
    adCampaignId: feedback.ad_campaign_id,
    adReviewFeedbackId: feedback.id,
  });

  const jobIds: string[] = [];
  try {
    for (const spec of specs) {
      const { data: jobRow, error: insErr } = await admin
        .from("agent_jobs")
        .insert({
          workspace_id: workspaceId,
          spec_slug: opts.specSlug ?? `ad-review-feedback:${adReviewFeedbackId}`,
          kind: spec.kind,
          instructions: JSON.stringify(spec.instructions),
        })
        .select("id")
        .single();
      if (insErr || !jobRow) {
        throw new Error(
          `enqueueAdReviewFeedback: agent_jobs insert failed for spec=${spec.kind}: ${insErr?.message ?? "no row"}`,
        );
      }
      jobIds.push((jobRow as { id: string }).id);
    }
  } catch (err) {
    // Partial dispatch: park the row `failed` so it's not stuck `processing`, and rethrow so
    // the caller / worker log surfaces the reason. `failed` is a terminal status; a follow-up
    // re-drive requires an explicit re-queue (the CEO cockpit's "retry" affordance in Phase 3).
    await transitionAdReviewFeedbackStatus(admin, {
      workspaceId,
      id: adReviewFeedbackId,
      from: "processing",
      to: "failed",
    }).catch(() => undefined);
    throw err;
  }

  const done = await transitionAdReviewFeedbackStatus(admin, {
    workspaceId,
    id: adReviewFeedbackId,
    from: "processing",
    to: "done",
  });
  if (!done) {
    // A concurrent flip is unusual (the row was ours) but not fatal — the jobs are queued and
    // the caller can see the actual status via a re-read. Log-friendly, non-throwing.
    console.warn(
      `enqueueAdReviewFeedback: processing→done CAS missed for id=${adReviewFeedbackId} (concurrent flip?)`,
    );
  }
  return { dispatched: true, specs, jobIds };
}
