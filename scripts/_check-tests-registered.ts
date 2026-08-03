/**
 * Static-analysis check: every `*.test.ts` in the repo has a registered `test:*` npm script in
 * package.json — because a test that no runner executes is not a test.
 *
 * SPEC: a-test-that-no-runner-executes-is-not-a-test-register-orphans-and-guard-new-ones Phase 3.
 * Measured on origin/main at ebedc4a39 (2026-07-27): 378 `*.test.ts` files vs 105 registered
 * `test:*` scripts → roughly 273 tests were inert. Phase 1 wrote the box auth-refresh regression
 * and registered it; Phase 2 registered today's six loyalty/appstle orphans that were shipping
 * dead. This guard is what stops the count climbing back — a NEW `*.test.ts` cannot land
 * unregistered. The remaining pre-Phase-2 backlog is grandfathered via the explicit dated
 * `GRANDFATHER_ALLOWLIST_2026_07_27` below. Adding a NEW file to that allowlist is a policy
 * violation (register the test instead); the failure message says so.
 *
 * The allowlist is shrink-only by design: registering an allowlisted file OR deleting it flags
 * that entry as STALE and fails the guard so the debt keeps shrinking. The check runs
 * synchronously with no I/O beyond `readFileSync` — safe to chain into `predeploy`.
 *
 *   Run:    npx tsx scripts/_check-tests-registered.ts
 *           npx tsx scripts/_check-tests-registered.ts --summary   # counts only, no per-line
 *   Wired:  `npm run check:tests-registered` → chained into `predeploy` (see package.json).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

/** Repo root — this file lives at <root>/scripts/_check-tests-registered.ts. */
const REPO_ROOT = join(__dirname, "..");

/**
 * Directories the walker never descends into (deps + hidden state only). We deliberately do NOT
 * blocklist common artifact names like "build" / "dist" / "out" / "coverage" — the repo has
 * legitimate SOURCE dirs named `src/lib/build/` etc., and blocklisting the base name would blind
 * the guard to real tests. This repo has no top-level `build/` / `dist/` / `out/` today (Next.js
 * writes to `.next/`, which IS listed), so restricting to dependency + hidden dirs is safe.
 */
const WALK_SKIP_DIR = new Set([
  "node_modules",
  ".next",
  ".git",
  ".box",
  ".turbo",
  ".vercel",
]);

/** Recursively enumerate every `*.test.ts` / `*.test.tsx` under `dir`. */
function walkTestFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    if (WALK_SKIP_DIR.has(entry)) continue;
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTestFiles(full, results);
    } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      results.push(full);
    }
  }
  return results;
}

/** Repo-relative POSIX paths of every `*.test.ts(x)` in scope, deduped + sorted. */
function allTestFiles(): string[] {
  const abs = walkTestFiles(REPO_ROOT);
  const rel = new Set<string>();
  for (const a of abs) rel.add(relative(REPO_ROOT, a).split(sep).join("/"));
  return [...rel].sort();
}

/**
 * Extract the test-file path referenced by every `test:*` npm script that runs `tsx --test <path>`
 * (the existing convention across the 111 pre-Phase-3 registered runners). A `test:*` that shells
 * out to something else (a jest wrapper, a shell script, etc.) is not counted here — no such
 * script exists in scope today; if one is added, extend `extractTestPathFromValue`.
 */
function registeredTestFiles(): Set<string> {
  const pkgPath = join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const set = new Set<string>();
  for (const [name, value] of Object.entries(scripts)) {
    if (!name.startsWith("test:")) continue;
    const path = extractTestPathFromValue(value);
    if (path) set.add(path);
  }
  return set;
}

/** `tsx --test <path>` → `<path>`. Returns null for any other shape. Whitespace-tolerant. */
function extractTestPathFromValue(value: string): string | null {
  const trimmed = value.trim();
  // Also match `tsx --test <path> --other-flag …` conservatively — the first arg is the file.
  const m = trimmed.match(/^tsx\s+--test\s+(\S+)/);
  return m ? m[1] : null;
}

/**
 * The dated grandfather allowlist. Every entry is a `*.test.ts` that existed on origin/main at
 * ebedc4a39 (2026-07-27) without a registered runner. The list is FROZEN — this guard treats a
 * NEW entry as a policy violation via the "shrink-only" invariant enforced elsewhere in this
 * module: an entry becomes STALE if the file is deleted OR the file gains a `test:*` runner, and
 * a stale entry fails the check. So the natural workflow is:
 *
 *   • register an orphaned test → the guard flags its allowlist row as stale → drop the row
 *   • delete a dead test file  → same
 *
 * The count only shrinks. A brand-new `*.test.ts` cannot bypass the guard by adding itself here
 * without both a code review AND (see the failure message below) explicit policy pushback.
 */
const GRANDFATHER_ALLOWLIST_2026_07_27: ReadonlySet<string> = new Set([
  "scripts/_audit-loyalty-double-spend-history.test.ts",
  "scripts/_check-authinterrupts-when-forbidden-imported.test.ts",
  "scripts/_check-sql-comment-literals.test.ts",
  "scripts/ad-creative-qc-guardrails.test.ts",
  "scripts/backfill-spec-checks-to-typed.test.ts",
  "scripts/build-meta-copy.test.ts",
  "scripts/builder-worker.stranded-fold.test.ts",
  "scripts/planner-chunk-authoring.test.ts",
  "scripts/planner-transcript-recover.test.ts",
  "scripts/pulse-recap-import-safety.test.ts",
  "scripts/pulse-recap.test.ts",
  "src/app/api/tickets/analytics/playbook-selection-split/aggregator.test.ts",
  "src/app/portal/[slug]/_sections/order-status.test.ts",
  "src/lib/account-matching.test.ts",
  "src/lib/action-executor.apply-loyalty-coupon-double-spend.test.ts",
  "src/lib/action-executor.atomic-redeem-apply.test.ts",
  "src/lib/action-executor.claim-guard-inline.test.ts",
  "src/lib/action-executor.reconcile-tenant-scope.test.ts",
  "src/lib/action-executor.verify-in-db.test.ts",
  "src/lib/adlibrary-winners.test.ts",
  "src/lib/adlibrary.fetchCreative-retry.test.ts",
  "src/lib/adlibrary.test.ts",
  "src/lib/ads-supervisor.coverage-executed.test.ts",
  "src/lib/ads/ad-creative-trigger.test.ts",
  "src/lib/ads/ad-insights-sdk.test.ts",
  "src/lib/ads/ad-review-feedback-router.test.ts",
  "src/lib/ads/ad-review-feedback.test.ts",
  "src/lib/ads/ads-read-sdk.test.ts",
  "src/lib/ads/angle-demand-sweep.test.ts",
  "src/lib/ads/creative-agent.creative-regen.test.ts",
  "src/lib/ads/creative-agent.derive-ad-name.test.ts",
  "src/lib/ads/creative-agent.test.ts",
  "src/lib/ads/creative-agent.timeline.test.ts",
  "src/lib/ads/creative-brief.test.ts",
  "src/lib/ads/creative-generate.competitor-offer-render.test.ts",
  "src/lib/ads/creative-generate.overlay-mode.test.ts",
  "src/lib/ads/creative-generate.test.ts",
  "src/lib/ads/creative-imitation.test.ts",
  "src/lib/ads/creative-learning.test.ts",
  "src/lib/ads/creative-overlay-landing.test.ts",
  "src/lib/ads/creative-overlay.phase3.test.ts",
  "src/lib/ads/creative-overlay.test.ts",
  "src/lib/ads/creative-pack-gate.test.ts",
  "src/lib/ads/creative-pack.test.ts",
  "src/lib/ads/creative-qa.dahlia-rubric.test.ts",
  "src/lib/ads/creative-qa.test.ts",
  "src/lib/ads/creative-side-by-side.test.ts",
  "src/lib/ads/creative-sourcing.acquisition-power.test.ts",
  "src/lib/ads/creative-sourcing.test.ts",
  "src/lib/ads/creative-sourcing.winner-tier.test.ts",
  "src/lib/ads/dahlia-rubric-gate.test.ts",
  "src/lib/ads/factor-rollup-sdk.test.ts",
  "src/lib/ads/placement-publish.test.ts",
  "src/lib/ads/postability-override.test.ts",
  "src/lib/ads/publish-adset-unavailable-classifier.test.ts",
  "src/lib/ads/publish-instagram-identity-guard.test.ts",
  "src/lib/ads/regenerate-existing-format.test.ts",
  "src/lib/ads/seed-angle-palette.test.ts",
  "src/lib/ads/select-angle-pattern.test.ts",
  "src/lib/ads/selection-engine.test.ts",
  "src/lib/ads/testing-results-sdk.test.ts",
  "src/lib/advertorial-pages.scent-match.test.ts",
  "src/lib/agent-jobs.m4-inline-stamp.test.ts",
  "src/lib/agent-jobs.premerge-deployment-ready.test.ts",
  "src/lib/agent-jobs.reconciler-verify-guard.test.ts",
  "src/lib/agents/approval-inbox-pr-resolve-park.test.ts",
  "src/lib/agents/director-kpis.test.ts",
  "src/lib/agents/kpi-review.test.ts",
  "src/lib/agents/needs-attention-classify.test.ts",
  "src/lib/agents/needs-attention-route-cs-owner.test.ts",
  "src/lib/agents/platform-director-backstop-reconcile.test.ts",
  "src/lib/agents/platform-director-escort-owner-agnostic.test.ts",
  "src/lib/agents/platform-director-reactive-approval.test.ts",
  "src/lib/agents/platform-director-routing.test.ts",
  "src/lib/agents/platform-director.reconcile-resolve.test.ts",
  "src/lib/ai-context.test.ts",
  "src/lib/assisted-purchase-analytics.test.ts",
  "src/lib/assisted-purchase-direction.test.ts",
  "src/lib/author-spec-parent-derive.test.ts",
  "src/lib/author-spec.buildStructuredSpecInputFromMarkdown.test.ts",
  "src/lib/author-spec.test.ts",
  "src/lib/automated-sender.test.ts",
  "src/lib/blocker-goal-normalize.test.ts",
  "src/lib/box-session-resume.test.ts",
  "src/lib/brain-roadmap.authors-via-structured-path.test.ts",
  "src/lib/build-spec-materializer.render.test.ts",
  "src/lib/build/check-reconciliation.judge-guard.test.ts",
  "src/lib/bundle-fulfillment.test.ts",
  "src/lib/central-day.test.ts",
  "src/lib/checkout-stuck-intent.test.ts",
  "src/lib/claim-guard.test.ts",
  "src/lib/claim-rpc-verify.test.ts",
  "src/lib/cockpit-resolver.test.ts",
  "src/lib/commerce/crisis-swap-rejected-sequencer.test.ts",
  "src/lib/commerce/crisis-swap-rejected.e2e.test.ts",
  "src/lib/commerce/crisis-swap-rejected.test.ts",
  "src/lib/commerce/founder-cancel-sms.test.ts",
  "src/lib/commerce/order-now-verify.test.ts",
  "src/lib/commerce/price.test.ts",
  "src/lib/control-tower/db-health.test.ts",
  "src/lib/control-tower/enforce-switch.test.ts",
  "src/lib/control-tower/kill-switch-resolver.test.ts",
  "src/lib/control-tower/legacy-switch-compat.test.ts",
  "src/lib/control-tower/monitor.test.ts",
  "src/lib/control-tower/node-registry.test.ts",
  "src/lib/control-tower/registry.test.ts",
  "src/lib/control-tower/self-audit.test.ts",
  "src/lib/control-tower/tickets-awaiting-handler-dispatch-workprobe.regression.test.ts",
  "src/lib/control-tower/tickets-awaiting-qc-workprobe.regression.test.ts",
  "src/lib/cora-triage-pass.test.ts",
  "src/lib/country-iso2.test.ts",
  "src/lib/coverage-register-agent.test.ts",
  "src/lib/creative-scout.guard.test.ts",
  "src/lib/creative-skeleton.fallback.test.ts",
  "src/lib/creative-skeleton.retryable-fetch.test.ts",
  "src/lib/cs-director-digest.capHits.test.ts",
  "src/lib/cs-director-digest.messyTurns.test.ts",
  "src/lib/cs-director-digest.perTicketEscalationTitle.test.ts",
  "src/lib/cs-director-escalate-founder-card.test.ts",
  "src/lib/cs-director-playbook-tier-eligibility.test.ts",
  "src/lib/cs-director-ticket-transition.test.ts",
  "src/lib/cs-director-verdict-note.test.ts",
  "src/lib/customer-shipping-address.audit.test.ts",
  "src/lib/customer-shipping-address.test.ts",
  "src/lib/cx-agent-sdk.test.ts",
  "src/lib/cx-agent-sdk.ticket-uuid-guard.test.ts",
  "src/lib/email-storefront.test.ts",
  "src/lib/email-typo.test.ts",
  "src/lib/email-utils.test.ts",
  "src/lib/every-deterministic-body-producer.test.ts",
  "src/lib/function-mandates.test.ts",
  "src/lib/goal-branch-ci-green.test.ts",
  "src/lib/goal-branch-rebase-merge.test.ts",
  "src/lib/goal-member-blocked-by.test.ts",
  "src/lib/goal-member-deadlock-autobreak.test.ts",
  "src/lib/goal-member-enqueue-admission.test.ts",
  "src/lib/goal-member-release-on-completion.test.ts",
  "src/lib/goal-promotion-surface.test.ts",
  "src/lib/honor-required-outcomes.test.ts",
  "src/lib/inbound-dispatch-gate.test.ts",
  "src/lib/inbound-image-normalize.test.ts",
  "src/lib/inflection-detector.applyGate.test.ts",
  "src/lib/inflection-detector.test.ts",
  "src/lib/inngest/ad-creative-cadence.test.ts",
  "src/lib/inngest/ad-tool.publish-adset-unavailable.test.ts",
  "src/lib/inngest/digital-goods-delivery.test.ts",
  "src/lib/inngest/dispatch-inbound-message.test.ts",
  "src/lib/inngest/internal-subscription-renewals.dunning-window.test.ts",
  "src/lib/inngest/media-buyer-cadence.test.ts",
  "src/lib/inngest/media-buyer-grade.test.ts",
  "src/lib/inngest/media-buyer-test-cadence.test.ts",
  "src/lib/inngest/returns-reconcile-sweep.decider.test.ts",
  "src/lib/inngest/returns.onfailure.test.ts",
  "src/lib/inngest/ticket-analysis-cron.gate.test.ts",
  "src/lib/inngest/triage-escalations.selection.test.ts",
  "src/lib/inngest/unanswered-inbound-backstop-cron.test.ts",
  "src/lib/integrations/amplifier.test.ts",
  "src/lib/internal-subscription.oneTimeGift.test.ts",
  "src/lib/journey-complete-close-contract.regression.test.ts",
  "src/lib/journey-complete-remedy-outcome-vocab.regression.test.ts",
  "src/lib/june-remedy-approval.founderPreview.test.ts",
  "src/lib/june-remedy-approval.loyalty-refusal.test.ts",
  "src/lib/june-remedy-approval.test.ts",
  "src/lib/label-cta.test.ts",
  "src/lib/logistics/storefront-availability.test.ts",
  "src/lib/loyalty.test.ts",
  "src/lib/mario.blocked-by-repair.test.ts",
  "src/lib/mario.blocked-by.test.ts",
  "src/lib/mario.eligible-never-enqueued.test.ts",
  "src/lib/mario.goal-member.test.ts",
  "src/lib/mario.live-fix-target-binding.test.ts",
  "src/lib/mario.orphaned-folded-pr.test.ts",
  "src/lib/mario.stuck-queued-storm.test.ts",
  "src/lib/media-buyer/agent.crown-tenant-scope.test.ts",
  "src/lib/media-buyer/all-customers-exclusion.test.ts",
  "src/lib/media-buyer/director-digest.test.ts",
  "src/lib/media-buyer/grader.test.ts",
  "src/lib/media-buyer/graduate-scaler.test.ts",
  "src/lib/media-buyer/meta-cpa-signal.test.ts",
  "src/lib/media-buyer/provision-cohort.test.ts",
  "src/lib/media-buyer/publish-gate.max-copy-qc.test.ts",
  "src/lib/media-buyer/publish-identity.test.ts",
  "src/lib/meta-ads.create.test.ts",
  "src/lib/meta-ads.customers-audience.test.ts",
  "src/lib/meta-ads.dual.rightcol.test.ts",
  "src/lib/meta-ads.placement.test.ts",
  "src/lib/meta-ads.uploadAdImage.test.ts",
  "src/lib/meta/performance.reconcile-dropped-adsets.test.ts",
  "src/lib/meta/recommendation-execute.test.ts",
  "src/lib/migration-safety-tag-pending-action.test.ts",
  "src/lib/model-picker.test.ts",
  "src/lib/move-replacement-offer.test.ts",
  "src/lib/no-progress-guard.test.ts",
  "src/lib/order-now-reachable.test.ts",
  "src/lib/orders-classification.test.ts",
  "src/lib/outcome-completion-gate.test.ts",
  "src/lib/outreach-route.test.ts",
  "src/lib/phantom-ship-detector.test.ts",
  "src/lib/playbook-compiler-seed.test.ts",
  "src/lib/playbook-compiler-sol.test.ts",
  "src/lib/playbook-executor.assisted-create.test.ts",
  "src/lib/playbook-executor.pause-skips-cancelled.test.ts",
  "src/lib/playbook-executor.session-chosen-only-exclusion.test.ts",
  "src/lib/playbook-matcher-defer.test.ts",
  "src/lib/playbook-supersede-guard.test.ts",
  "src/lib/portal/enqueue-sol-first-touch.test.ts",
  "src/lib/portal/escalate-sol-rail-hit.test.ts",
  "src/lib/portal/failed-payment-guard.test.ts",
  "src/lib/portal/handlers/bootstrap.test.ts",
  "src/lib/portal/mutation-guard.test.ts",
  "src/lib/portal/order-now-guard.test.ts",
  "src/lib/portal/safe-starts-with.test.ts",
  "src/lib/portal/sol-proposed-spec.test.ts",
  "src/lib/portal/suppressed-variants.test.ts",
  "src/lib/pricing.grandfathered.test.ts",
  "src/lib/refund-ledger.reconcile.test.ts",
  "src/lib/repair-agent.test.ts",
  "src/lib/replacement-order.test.ts",
  "src/lib/replacement-stall.test.ts",
  "src/lib/required-outcomes-validator.test.ts",
  "src/lib/roadmap-actions.queue-build-kind-filter.test.ts",
  "src/lib/security-agent.test.ts",
  "src/lib/selective-clarify.test.ts",
  "src/lib/serial-claim-dispatch-outcome.test.ts",
  "src/lib/shopify-order-actions.pending-refund.test.ts",
  "src/lib/shopify-returns.closeReturn.test.ts",
  "src/lib/shopify-returns.synthesize.test.ts",
  "src/lib/shopify-theme-hidden-variants.test.ts",
  "src/lib/silent-turn-guard.test.ts",
  "src/lib/sms-marketing-agent.test.ts",
  "src/lib/sol-closes-ticket.e2e.test.ts",
  "src/lib/sol-coaching-signal.test.ts",
  "src/lib/sol-cta-reference-guard.test.ts",
  "src/lib/sol-direction-apply.test.ts",
  "src/lib/sol-dispatch.e2e.test.ts",
  "src/lib/sol-link-proposal.test.ts",
  "src/lib/sol-mechanism-arm.test.ts",
  "src/lib/sol-move-dead-end-guard.test.ts",
  "src/lib/sol-outcome-claim-guard.test.ts",
  "src/lib/sol-policy-bait-guard.test.ts",
  "src/lib/sol-reopen-on-inbound.regression.test.ts",
  "src/lib/sonnet-orchestrator-v2-merge-summary.test.ts",
  "src/lib/spec-card-state.mirror-status.test.ts",
  "src/lib/spec-check-db-probes.test.ts",
  "src/lib/spec-check-runner.preview-redirect.test.ts",
  "src/lib/spec-check-runner.test.ts",
  "src/lib/spec-phase-checks-table.test.ts",
  "src/lib/spec-phase-provenance.test.ts",
  "src/lib/spec-test-runs.test.ts",
  "src/lib/specs-table.compensate-partial-write.test.ts",
  "src/lib/specs-table.empty-phases-gate.test.ts",
  "src/lib/specs-table.list-egress.test.ts",
  "src/lib/specs-table.upsert-gate.test.ts",
  "src/lib/specs-table.verify-phase-on-branch.test.ts",
  "src/lib/subscription-items.swapPricing.test.ts",
  "src/lib/subscription-renewal-guard.test.ts",
  "src/lib/ticket-analyzer.coachingMap.test.ts",
  "src/lib/ticket-analyzer.cost.test.ts",
  "src/lib/ticket-analyzer.escalation-decision.test.ts",
  "src/lib/ticket-analyzer.grader-prompt.test.ts",
  "src/lib/ticket-analyzer.rubric.test.ts",
  "src/lib/ticket-analyzer.sole-unverified-escalation.test.ts",
  "src/lib/ticket-analyzer.tiered-ladder.test.ts",
  "src/lib/ticket-directions.test.ts",
  "src/lib/ticket-merge.test.ts",
  "src/lib/utm.test.ts",
]);

interface Report {
  totalFiles: number;
  registeredCount: number;
  allowlistCount: number;
  newOrphans: string[];
  staleAllowlist: string[];
}

export function auditTestRegistrations(): Report {
  const all = allTestFiles();
  const registered = registeredTestFiles();
  const newOrphans: string[] = [];
  for (const f of all) {
    if (registered.has(f)) continue;
    if (GRANDFATHER_ALLOWLIST_2026_07_27.has(f)) continue;
    newOrphans.push(f);
  }
  const allSet = new Set(all);
  const staleAllowlist: string[] = [];
  for (const f of GRANDFATHER_ALLOWLIST_2026_07_27) {
    if (!allSet.has(f) || registered.has(f)) staleAllowlist.push(f);
  }
  staleAllowlist.sort();
  return {
    totalFiles: all.length,
    registeredCount: registered.size,
    allowlistCount: GRANDFATHER_ALLOWLIST_2026_07_27.size,
    newOrphans,
    staleAllowlist,
  };
}

function main(): void {
  const summary = process.argv.includes("--summary");
  const r = auditTestRegistrations();
  const activeDebt = r.allowlistCount - r.staleAllowlist.length;
  const banner = `[check:tests-registered] total=${r.totalFiles}  registered=${r.registeredCount}  grandfathered=${activeDebt}/${r.allowlistCount}  new-orphans=${r.newOrphans.length}  stale-allowlist=${r.staleAllowlist.length}`;
  if (r.newOrphans.length === 0 && r.staleAllowlist.length === 0) {
    console.log(`✔ ${banner}`);
    process.exit(0);
  }
  console.error(`✘ ${banner}`);
  if (r.newOrphans.length) {
    console.error(
      `\n❌ ${r.newOrphans.length} *.test.ts file(s) have NO "test:*" runner in package.json AND are not in the dated grandfather allowlist:`,
    );
    if (!summary) for (const f of r.newOrphans) console.error(`   • ${f}`);
    console.error(
      `\nA test that no runner executes is not a test. Register each above by adding:`,
    );
    console.error(
      `   "test:<short-name>": "tsx --test <path>"`,
    );
    console.error(
      `to package.json's "scripts" block. Do NOT extend GRANDFATHER_ALLOWLIST_2026_07_27 — that list is dated and shrink-only; adding a new file to it defeats the guard the spec (a-test-that-no-runner-executes-is-not-a-test-register-orphans-and-guard-new-ones Phase 3) exists to enforce.`,
    );
  }
  if (r.staleAllowlist.length) {
    console.error(
      `\n⚠  ${r.staleAllowlist.length} allowlist entries are STALE (file was deleted OR the test is now registered — remove the entry to shrink the debt count):`,
    );
    if (!summary) for (const f of r.staleAllowlist) console.error(`   • ${f}`);
    console.error(
      `\nEdit scripts/_check-tests-registered.ts and drop each above line from GRANDFATHER_ALLOWLIST_2026_07_27.`,
    );
  }
  process.exit(1);
}

// Guard against `import`-time execution when unit-tested: only run when this file IS the entry
// point (matches the pattern the other scripts/_check-*.ts guards use).
if (require.main === module) {
  main();
}
