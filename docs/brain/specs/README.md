# Backlog — active projects + recently shipped

Single source of truth for what's being built next, what's parked, and what just shipped. Replaces the loose `project_*.md` files that used to live in agent memory.

## How to use this

- **Status emojis** (per the convention in [[../project-management]]): ⏳ planned · 🚧 in progress · ✅ shipped (then folded + removed).
- Three active project tracks today. Each has shipped sub-phases (documented in the linked lifecycle) and open sub-work that should be promoted into individual `docs/brain/specs/{slug}.md` files as soon as it's concrete enough to fire `/goal` at.
- When a sub-phase ships, fold its content into the relevant lifecycle/table/library pages and delete the spec file (per [[../project-management]] § Folding a shipped spec into the brain).

---

## Active project — Automated Organic Social Scheduler ⏳

**Spec:** [[automated-social-scheduler]]

**Why this matters:** always-on organic posts/reels/stories to FB + IG for customer engagement, sourced from existing assets (campaign avatar-holding-product images, finished ad videos, blog resources) with PI-grounded copy. Live test 2026-06-10 proved our current page tokens can publish on both platforms — no new scopes. Rolling 7-day window: daily planner cron tops up the calendar, Inngest publishes each post at its time. Dashboard shows posted + scheduled.

## Active project — Roadmap Build Console ⏳

**Spec:** [[roadmap-build-console]]

**Why this matters:** a phone-first dashboard console that closes the loop from idea → merged PR with no laptop. Three surfaces over infra we already have ([[../lifecycles/agent-todo-system]]): a roadmap board that reads the brain's spec/lifecycle status; a spec-authoring chat (Opus via API — cheap conversation tokens) that talks a feature through and writes `specs/{slug}.md` + queues a build; and a build dispatcher that runs the spec autonomously on the **Max subscription** via a **self-hosted Ubuntu box (Hetzner CCX33, Tailscale-locked) + a `systemd` worker** that polls an `agent_jobs` queue and runs `env -u ANTHROPIC_API_KEY claude -p` (no API key → subscription-billed), opening a `claude/*` PR squash-merged from [[../dashboard/branches]]. Builds that hit a decision **pause with structured questions** (job row + draft PR) and **resume the same session** (`claude --resume <session_id>`) once answered from the phone — no tmux, the worker + on-disk transcripts are the persistence.

## Active project — Build Approval Gates + Execution Hardening ⏳

**Spec:** [[build-approval-gates]]

**Why this matters:** lets autonomous builds run with no per-tool back-and-forth (bypass) while staying safe — irreversible/prod actions (apply migration, run prod script, merge) come back as one-tap approvals on the spec/phase card, executed by the trusted worker (the build itself has no prod creds). Extends [[../tables/agent_jobs]] (the live DB companion to the static brain) with a `needs_approval` layer; builds run non-root under [[../recipes/build-box-setup]].

## Active project — Goal Decomposition Engine ⏳

**Spec:** [[goal-decomposition-engine]]

**Why this matters:** a layer above specs — write a huge company goal (a BHAG) and a **planner** agent does gap-analysis against the brain, proposes a milestone → spec tree, and (once you approve the branches) auto-authors the leaf specs + queues their builds. Where `build-spec` turns a spec into a PR, the planner turns a goal into specs — same box-worker substrate ([[roadmap-build-console]], [[../tables/agent_jobs]]), one altitude up. Decomposition is human-gated (propose → approve direction → build → merge). First inhabitant: [[../goals/ceo-mode|CEO mode]], whose first plan pass surfaces the data/integration gaps (Amazon, COGS/supplier, a unified metrics spine) as proposed specs.

## Active project — Clear Escalation Flags on Resolve/Close ⏳

**Spec:** [[clear-escalation-on-resolve]] · **Owner:** [[../functions/cs]]

**Why this matters:** closing/resolving a ticket never clears `escalated_at`, so resolved tickets linger on the Escalated list (one sat 16 days post-close — Sheryl Dickey "Wrong product delivered"). Fix: clear escalation flags on resolve/close in the status-write paths + filter the Escalated view to non-terminal statuses + a gated stale sweep (currently 0). Completes [[box-escalation-triage]].

## Active project — Spec Blockers ⏳

**Spec:** [[spec-blockers]] · **Owner:** [[../functions/platform]]

**Why this matters:** formalizes the manual "queue after X merges" chaining (and prevents the parallel-build dirty-PR collisions we kept hitting). A spec declares `**Blocked-by:** [[other-spec]]`; the build enqueue chokepoint (`queueRoadmapBuild`) **refuses to queue** until every blocker has shipped; the board disables Build with a "🔒 Blocked by …" chip. P2 auto-queues the dependent build when the last blocker merges (native version of the watchers I launch by hand). Extends [[roadmap-build-console]].

## Active project — Error-Feed Monitoring (Vercel · Inngest · Supabase) ⏳

**Spec:** [[error-feed-monitoring]] · **Owner:** [[../functions/platform]] · **Blocked-by:** [[control-tower]]

**Why this matters:** the three "hidden surfaces" where failures hide — Vercel runtime errors, Inngest errored runs, Supabase errors — piped into the Control Tower so they page you + show on the dashboard instead of being found by a customer report. P1: Inngest `function.failed` handler (native) + Vercel Log Drain→webhook (I set up the drain) + an app-layer `reportDbError` (catches the swallowed-error class, no token). P2: Supabase Management Logs API (the one part needing an owner-generated Supabase access token). Extends [[control-tower]].

## Active project — Subscription Overcharge Remediation ⏳

**Spec:** [[subscription-overcharge-remediation]] · **Owner:** [[../functions/retention]]

**Why this matters:** the capability the system should've had on Jim Leone's ticket — his grandfathered pricing dropped → Appstle billed $229.26 vs $139.84, he asked to cancel, and triage authored a (forbidden) build-order-cancellation spec instead of fixing the real issue. Detect a renewal **overcharge from dropped grandfathered pricing** → partial-refund the delta → **Appstle pricing-policy heal** (never migrate-to-internal w/o a saved PM) → reply. Plus triage grounding: check overcharge before create_return/cancel; never author a code_gap spec that contradicts a policy; always propose a customer_reply. (Jim fixed by hand: $89.42 refunded, base healed to $139.84/4.) Replaces the deleted cancel-order-direct-action spec.

## Active project — Iteration Ingest: Async Reports (deferred) ⏳

**Spec:** [[iteration-ingest-async-reports]] · **Owner:** [[../functions/growth]]

**Why this matters:** the originally-deferred Phase 3 of [[iteration-engine-ingest-resilience]], split into its own card so the parent reads ✅ shipped. A **build-on-demand** optimization: use Meta's async insights-report path for huge first-run backfills — only if the ≤14-day chunked path ever strains. Deferred until that's observed.

## Active project — control_tower_loop_beats RPC perf ⏳

**Spec:** [[control-tower-loop-beats-rpc-perf]] · **Owner:** [[../functions/platform]]

**Why this matters:** the bounded-read RPC from control-tower-monitor-accuracy is itself 500-ing (×15) — its `row_number()`/`count(*) OVER partition` scans + sorts ALL cron/agent beats unbounded → statement timeout (the same full-sort degradation it replaced). control-tower-beats-read-failure-guard (#203) makes the snapshot tolerate it (amber), but the monitor then flies blind. Fix: lateral join (distinct loop × index-limited latest-N) + drop the costly all-time count (presence ⇒ ever-beaten). Found while investigating the live RPC-500; re-creates the fix wrongly deleted in the repair-agent dedup cleanup.

## Active project — Control Tower triage round 2 (from the queue workflow) ⏳

Two real bugs the human-queue verification workflow surfaced (2026-06-22):
- [[inngest-registered-diff-endpoint-fix]] (platform) — diffInngestRegistered hits GET /v1/apps (404); correct = /v1/apps/shopcx/functions (id-keyed). The registration-gap check is dead until fixed (the spec's own ⚠️).
- [[control-tower-renewal-integrity-assertions]] (retention) — control-tower P2 renewal-integrity only built the overdue check; outcome-distribution (decline/no-PM spike) + stuck-dunning assertions were never implemented. Renewal breaks silently.

## Active project — Client-Side Error Capture ⏳

**Spec:** [[client-error-capture]] · **Owner:** [[../functions/platform]]

**Why this matters:** the Control Tower's 3 error feeds (Vercel/Inngest/Supabase) are all SERVER-side. Client-side JS that breaks the UX in the browser — a PDP render crash, a broken customize interaction, a Braintree widget failing on checkout (silent lost revenue), a portal crash — is invisible to us (no error boundary / window.onerror / Sentry exists; only a narrow checkout-only logger). Fix: the missing 4th feed — global error boundary + window.onerror/unhandledrejection on storefront + portal → /api/client-errors → recordError(source:'client') → a "Client errors" Control Tower panel. Rate-limited, PII-stripped, fail-open.

## Active project — Meta insights ingest empty (ROAS broken) ⏳

**Spec:** [[meta-insights-ingest-empty-fix]] · **Owner:** [[../functions/growth]]

**Why this matters:** live regression — the iteration engine's Meta insights tables (meta_insights_daily/campaigns/adsets/ads) are EMPTY, scorecards exist only at variant/angle (zero ad/adset/campaign grain), and all 111 meta_attribution_daily rows have attributed_spend_cents=0 → per-variant ROAS is meaningless. The ingest reports status='ok' the whole time (silent false-success). Investigate why the ingest writes zero ad-level rows + fix population + attribution + add a rows-written output assertion so it can't silently degrade again.

## Active project — Goal-decomposition self-sequencing ⏳

[[goal-decomposition-encodes-blockers]] (platform) — dogfood finding from the engine's first real run (the storefront-optimizer tree): it decomposed perfectly but set NO dependencies, so the owner had to approve in manual waves. spec-blockers enforcement already exists (Blocked-by header → build-gate + auto-queue-on-unblock); the planner just needs to EMIT blocked_by. Then a goal plan is self-sequencing — approve the whole tree, builds fire in order.

## Active project — Control Tower migration-drift check ⏳

[[control-tower-migration-drift-check]] (platform) — dogfood finding: migration 20260618140000_meta_performance_tables was silently skipped in prod → meta_campaigns/adsets/ads/insights_daily never existed → swallowed PGRST205 → empty ROAS data for weeks, found only by manual investigation. Add a Control Tower check that diffs migration-created tables vs the live schema + alerts on any missing (drop-aware, sunset-allowlisted). Runs on the box (has files + DB).

## Active project — Auto-Ship Pipeline ⏳

[[auto-ship-pipeline]] (platform) — automate the two rubber-stamp clicks the owner makes without review: (A) auto-merge ready claude/* PRs (mergeable + green → serialized squash-merge; conflicting ones still go to the dirty-PR-resolver) and (B) auto-fold fully-verified specs (shipped + agent-approved + 0 waiting/failed human checks + 0 regressions → enqueue_fold). Bounded proxies, owner kill-switch per gate, both registered as Control Tower loops, post-merge spec-test is the safety net.

## Active project — Worker-orphan-reaper worktree prune ⏳

[[worker-orphan-reaper-worktree-prune]] (platform) — the box never cleans git worktrees: (1) a resume's `git worktree add` fails "already used by worktree" when the first run left one (caused the auto-ship-pipeline build failure), and (2) stale worktrees for merged/terminal branches accumulate (3 found by hand). Fix: idempotent worktree-add (force-remove existing first) + reap worktrees whose job is terminal / branch deleted, in reapOrphans. Never touches active builds.

## Active project — spec-drift-reconcile not firing ⏳

[[spec-drift-reconcile-not-firing]] (platform) — the every-30min drift backstop has NEVER fired (0 heartbeats), so roadmap cards drift (ticket-csat #219, portal-auto-resume #218 sat stale). Not a code bug (manual sweep works) nor a registration gap (it's in Inngest's registered set) — a registered cron with a valid schedule simply isn't executing, and the Control Tower only checks served-but-not-registered, not registered-but-never-firing. Fix the firing + add the zero-beats-past-window guard.

## Active project — Build-all-phases chain ⏳

[[build-all-phases-chain]] (platform) — kill the phase-by-phase babysitting on milestone builds. Part A: a "Build all" action chains phases automatically — build P1 → auto-merge → queue P2 → … until all ✅ (stops on a phase fail / needs_approval; composes with auto-ship-pipeline auto-merge). Each phase stays a bounded, isolated, resumable build (vs a risky 1hr atomic build). Part B: replace the hard 30-min BUILD_TIMEOUT wall with output-idle hang detection (~10min idle kill) + a 60-min hard cap — "fail only if hung."

## Active project — Roadmap goal + source filters ⏳

[[roadmap-goal-and-source-filters]] (platform) — the board carries specs from goals/planner/repair/manual; add a goal selector (focused goal-progress view: pick a goal → only its specs + an X/Y-shipped header) + source chips (🎯 Goal / 🔧 Repair / ✋ Manual, derived from goal-doc wikilinks + Repair-signature) composing with the existing search. Client-side via data-goal/data-source attributes; no schema change.

## Active project — Spec-card DB companion 🚧

[[spec-card-db-companion]] (platform) — SUPERSEDES + RETIRES the disabled git-reads approach (roadmap-reads-specs-from-git, now deleted). Move live PM state into a spec_card_state DB table the board reads instantly (no deploy lag, no GitHub quota): merge/drift/owner/build events write status+flags the moment they happen. Markdown stays canonical for content (brain rule holds); DB is the live board mirror + transient flags. "shipped · deploying" flag via VERCEL_GIT_COMMIT_SHA vs the card's merge SHA (no webhook). **Phase 1 shipped:** table + instant writers + DB-first board read + deploy-pending flag; the dead git-reads machinery is removed.

## Active project — Box multi-account failover ⏳

[[box-multi-account-failover]] (platform) — survive the Max usage wall: the box (same account as the owner) capped → 12 builds failed at once with no recovery until reset. Wire the worker to select CLAUDE_CONFIG_DIR per build from an account pool + auto-fail-over to a 2nd account on a usage-cap signal (vs the existing 529-transient retry); all-capped → blocked_on_usage that auto-resumes (no manual rebuild). + the claude2 alias / ~/.claude-personal login for manual use. Owner's idea, made automatic.

## Active project — Fold guard (live build) ⏳

[[fold-guard-live-build]] (platform) — a spec (control-tower-escalation-idle-grace) was folded+archived while a needs_input build was live → orphaned build showed as "paused" on the box with a 404 link. Guard: the fold path refuses/defers folding a spec with a non-terminal job; archiving a spec cancels its orphaned jobs; the box callout tolerates a missing spec. Matters more once auto-fold runs.

## Active project — dirty-PR-resolver duplicate detection ⏳

[[dirty-pr-resolver-duplicate-detection]] (platform) — storefront-lever-importance-memory built twice (account-switch recovery): #252 merged, #249 left a duplicate that's permanently CONFLICTING (work already on main), so the resolver spawned 9 unresolvable pr-resolve jobs in a loop (burning Max tokens). Fix: resolver closes a PR whose spec already merged via a sibling (instead of looping); dedupe build/PR-create + requeue on a merged build PR per spec; cap pr-resolve retries with owner surfacing.

## Active project — Chain + card-state under auto-merge ⏳

[[chain-and-cardstate-under-automerge]] (platform) — "Build all" on storefront-ltv-proxy-reconciler: P1 auto-merged but card stayed Planned (should be In progress) AND P2 never queued. Two bugs: (A) merge-write stored H1-derived status not a phase_states rollup; (B) the chain-continue + card-state-write live in reconcileMergedJobs (board-render), but auto-ship merges via webhook server-side → job already merged → both skipped. Fix: rollup status from phases + fire chain-continue/card-write on the auto-merge path itself.

## Active project — Box lane shows phase ⏳

[[box-lane-show-phase]] (platform) — with Build-all chaining, a box lane shows only the slug; surface which phase ('slug · Phase 2'). Worker derives phase from the job (LaneRow.phase) → box API passes it → box/page.tsx renders it.

## Active project — Storefront Optimizer activation gate ⏳

[[storefront-optimizer-activation-gate]] (growth) — closes a safety gap: the optimizer specs say "auto-run within policy" + "scope: Amazing Coffee" but define NO on-switch or enforced scope, so M4's cron would auto-run live experiments on customers with no explicit enablement. Add storefront_optimizer_policy (active=false default, product_scope=Amazing Coffee, guardrails) mirroring iteration_policies: OFF ⇒ propose-only (zero live experiments); flip on = the owner's "go"; scope enforced not narrative. GATES M4.

## Active project — Optimizer launch hardening ⏳

[[optimizer-launch-hardening]] (platform) — 5 findings from the pre-A/B-approval review (tsc clean, customer path SAFE, no false-✅). P1: optimizer approval re-asserts scope/active (TOCTOU) + add blocked_on_usage to JobStatus/ACTIVE_STATUSES (fold-guard drift). P2: auto-merge gates on the build job's success not GitHub's vacuous 'clean' (no CI exists). P3: plan-resume un-park only healthy-account jobs + tighten optimizer-policy RLS. None block the A/B approval.

## Active project — loop_heartbeats retention ⏳

[[loop-heartbeats-retention]] (platform) — loop_heartbeats grew to 21M rows/4.5GB unbounded → control_tower_loop_beats RPC times out → every Control Tower card shows "beat read unavailable — status unknown". Fix: daily batched prune to 3 days (retention cron, itself monitored) + verify the RPC uses the index / drives distinct loops from MONITORED_LOOPS not a full scan. One-time 21M backlog prune run with owner authorization.

## Active project — Repair Agent ⏳

**Spec:** [[repair-agent]] · **Owner:** [[../functions/platform]]

**Why this matters:** the standing agent-form of the manual Control-Tower triage loop. Event-triggered (a new error_events signature / loop_alert → a `repair` job, deduped, own lane), it investigates read-only, classifies (real bug / false-positive / noise / transient), and **authors a fix spec + surfaces it for one-tap owner Build** — does NOT auto-queue builds (North star: don't let a proxy-optimizer spawn code builds from a noisy feed), except a narrow `REPAIR_AUTOBUILD_KINDS` allow-list for mechanical/self-evident classes. "Escalation-triage, but for the Control Tower."

## Active project — Control Tower triage (2026-06-22) ⏳

Born from a full Control Tower audit. Each fixes a real red/error or a monitor false-positive:
- [[control-tower-monitor-accuracy]] (platform) — never-fired keys off "0 beats EVER" not "0 since deploy" (clears the today-sync/meta-capi/etc. false-reds) + bound the loop_heartbeats read that's 500-ing.
- [[serve-unserved-crons]] (platform) ✅ — deliver-pending-sends + marketing-text-campaign-send-tick: investigated → both **already** served (always have been) + registered + heartbeat-wired; decision = both should run, no code change. The never-fired flag was the heartbeat-primitive-didn't-exist-until-#185 false positive that [[control-tower-monitor-accuracy]] clears.
- [[appstle-webhook-billing-error]] (retention) — recurring 500 on subscription.billing-* events; fix the throw / ack semantics.
- [[scorecards-notnull-guard]] (growth) — 23502 NOT-NULL violation dropping scorecard rows; guard the null column.
- [[inngest-capture-scope-own-app]] (platform) — a sibling app (shopgrowth) bleeds into our Inngest failure feed; scope capture to our served functions.
*No-op:* 502 /api/branches (×1) — coincided with the GitHub rate-limit exhaustion, transient.

## Active project — Worker Orphan-Reaper ⏳

**Spec:** [[worker-orphan-reaper]] · **Owner:** [[../functions/platform]]

**Why this matters:** when the box worker restarts (self-update / deploy / crash) its in-flight jobs are orphaned — the new worker only claims `queued`, so old `building` rows sit stuck forever + trip the Control Tower stuck-jobs alert (hit live: 7 spec-tests piled up across deploys). Fix: reap on startup — reset re-runnable kinds (spec-test/triage/migration-fix/dev-ask/pr-resolve) to queued, mark producer kinds (build/plan/fold/…) failed (→ failed-builds callout + Create-PR recovery), cutoff-gated by the worker's started_at so live jobs are untouched.

## Active project — Build Recover: Create PR ⏳

**Spec:** [[build-recover-pr-create]] · **Owner:** [[../functions/platform]]

**Why this matters:** when a build succeeds + pushes its branch but `gh pr create` fails (transient), the job goes needs_attention and the card only offers Rebuild — which discards a completed build (hit live with control-tower P1 / #185). Fix: worker retries pr-create first; the card offers **Create PR** (open the PR for the pushed branch → job completed) for the recoverable case, Rebuild stays secondary.

## Active project — Fix Ships → Re-test Origin ⏳

**Spec:** [[fix-ship-retests-origin]] · **Owner:** [[../functions/platform]]

**Why this matters:** propose-fix → fix ships → but the origin spec's card keeps showing stale "Agent-tested · issues" because nothing re-tests it (observed: comp-subscriptions stayed red after comp-transaction-type-constraint shipped the fix). Fix: stamp a machine-readable `Fixes: {origin} ({check_keys})` in the proposed-fix spec; on the fix build's merge, auto-enqueue the origin's spec-test → the previously-failing check re-runs and the badge clears (or stays red, honestly, if the fix didn't resolve it).

## Active project — Error-Feed Honest Panels ⏳

**Spec:** [[error-feed-honest-panels]] · **Owner:** [[../functions/platform]]

**Why this matters:** the Control Tower's Vercel/Inngest/Supabase panels show green "0 errors" even when the source isn't connected (forward-only + unwired) — a disconnected monitor reading "all clear" is the exact Goodhart silent-failure the Control Tower exists to catch. Fix: connection-aware states — amber "not configured" / "awaiting first event" vs green "connected · 0 errors"; header health count excludes unconfigured panels.

## Active project — Spec-Drift Agent ⏳

**Spec:** [[spec-drift-agent]] · **Owner:** [[../functions/platform]]

**Why this matters:** builds merge without their phase emoji flipping ✅, so shipped work parks in Planned/In-progress (caught by hand twice). Two parts: (A) root fix — the build **stamps the phase it built ✅ on merge** (verified vs code-on-main, reusing the spec-file writeback); (B) a **per-phase reconciler** that flips a phase ✅ only with merged-build + code-on-main evidence and **never touches a genuinely-pending phase** (so multi-phase specs like pdp-refinement-pass P3 fan-out stay correctly in-progress). Ambiguous cases surface on the Control Tower for a one-tap flip. Event-on-merge + self-audit backstop.

## Active project — Dirty-PR Resolver Agent ⏳

**Spec:** [[dirty-pr-resolver-agent]] · **Owner:** [[../functions/platform]]

**Why this matters:** parallel/failed-then-rebuilt builds keep producing dirty (CONFLICTING) `claude/*` PRs (hand-resolved a dozen this week). Event-driven (a GitHub webhook on push-to-main — what *makes* PRs conflict — NOT a cron): detect newly-dirty `claude/*` PRs → a `pr-resolve` box agent merges origin/main, resolves additively, tsc-gates, pushes — or, when two builds diverged heavily / tsc can't pass, rebuilds-on-main or surfaces for a human (never force-merges). Complements [[spec-blockers]] (which prevents collisions). Box-agent family.

## Active project — Control Tower: Complete Coverage + Department Rollups ⏳

**Spec:** [[control-tower-complete-coverage]] · **Owner:** [[../functions/platform]] · **Blocked-by:** [[control-tower-agent-coverage]]

**Why this matters:** audit found the Control Tower covers ~7 of ~25 crons + almost no reactive/event agents — incl. the **inbound ticket handler** (the crucial one). Hand-registering forever doesn't scale. P1: register the full cron set + key reactive agents + a **self-audit** that enumerates every `inngest.createFunction` and flags any unregistered loop (gaps surface automatically). P2: **department rollups** — tag each loop with its owner function and show CEO-mode-style "Platform/Growth/Retention/CS/CMO Health" rollup tiles instead of a flat card wall. Extends [[control-tower]].

## Active project — Control Tower: Inline AI Agent Coverage ⏳

**Spec:** [[control-tower-agent-coverage]] · **Owner:** [[../functions/platform]]

**Why this matters:** Control Tower monitors crons + box-worker kinds but **not the inline server-side AI agents** — the ticket analyzer (QC grader), journey delivery, fraud detector, orchestrator. If the analyzer silently stops scoring/escalating tickets, nothing pages you. Register each with a heartbeat + work-exists/error-rate assertion + a sweep of all AI entry points. P1: ticket-analyzer (flagship) + journey-delivery + fraud-detector; P2 (blocked-by subscription-overcharge-remediation, shares the orchestrator file): the Sonnet orchestrator. Extends [[control-tower]].

## Active project — Control Tower (autonomous-loop observability) ⏳

**Spec:** [[control-tower]] · **Owner:** [[../functions/platform]]

**Why this matters:** we run ~dozen autonomous loops; this week three failed **silently** (idle escalation cron, swallowed scorecard upsert reporting false success, lingering stale ticket) — caught by luck, not design (Goodhart: proxy "completed" while objective failed). Each loop emits a **heartbeat + expected-output assertion**; a `control-tower-monitor` cron pages the owner (Slack) on **silence or false-success**, with a Control Tower dashboard (green/amber/red per loop). The observability layer that lets us *trust* the autonomy. P1 liveness+alerting+dashboard, P2 output assertions (idle-while-work, produced-but-not-persisted).

## Active project — "AI Investigation" Ticket Visibility ⏳

**Spec:** [[ai-investigation-ticket-visibility]] · **Owner:** [[../functions/cs]]

**Why this matters:** a routine-escalated ticket (`escalated_to=null`) gives a human agent no visual signal it's escalated or that triage is on it. Adds a prominent **"🔍 Escalated → AI Investigation"** badge (header + list + Escalated view, "· triage in progress" when a job is live) + `[AI Investigation]` internal notes when the routine starts working it and on outcome (proposed todos / no-quorum / mis-escalation). Humans can still intervene. Queue after [[escalate-to-routine-by-default]] merges (shared ticket UI). Refines [[box-escalation-triage]].

## Active project — Escalate to the AI Routine by Default ⏳

**Spec:** [[escalate-to-routine-by-default]] · **Owner:** [[../functions/cs]]

**Why this matters:** the hourly escalation-triage cron has been idle because nothing is escalated *to the routine* — every escalation path round-robins to a human (`escalated_to = assignee`), but the cron triages `escalated_at` set + `escalated_to IS NULL`. Fix: system escalations default to `escalated_to = null` (route to routine), add a first-class "🤖 AI Routine" option to the escalate UI + display, no-quorum still hands up to a human. No schema change (NULL = routine; `escalated_to` FKs auth.users). Completes [[box-escalation-triage]].

## Active project — Spec-Test Deep Verification ⏳

**Spec:** [[spec-test-deep-verification]] · **Owner:** [[../functions/platform]]

**Why this matters:** of the ~55 "needs human" spec-test checks, ~38 aren't truly human — ~30 are behavioral E2E (fire event/call API/approve → assert DB+events) the agent punts only because it's read-only, ~8 are UI render/click it can't do without a browser. Two new powers: **P1 headless-browser (Playwright)** for UI checks (minted owner session, read-only nav), **P2 sandboxed behavioral triggers** (fire Inngest events + internal POSTs against dedicated `is_test` fixtures, assert, clean up). Hard firewall: any real-customer/$/external-API/live-Meta side effect stays `needs_human`. Shrinks the human queue ~55 → ~15. All setup is self-owned (Playwright provisioning + test fixtures); no owner action. Extends [[spec-test-agent]].

## Active project — Iteration Scorecard Upsert Resilience ⏳

**Spec:** [[iteration-scorecard-upsert-resilience]] · **Owner:** [[../functions/cmo]]

**Why this matters:** real regression on [[storefront-iteration-engine]] — `computeScorecards` swallows the `iteration_scorecards_daily` upsert error + returns `rows: records.length` regardless, so a failing batch (one bad record — likely an unresolved `angle_id`/`advertorial_page_id`/`parent_*` FK; upsert is all-or-nothing) persists **0 rows** while reporting 7. The whole ad-iteration decision engine then reads 0 scorecards. Fix: check the error + fail loud + return real count; null unresolved FKs / per-row fallback so one bad row can't drop the batch; backfill once. Probe-confirmed it's not a schema fault.

## Active project — Base Price Never Above MSRP ⏳

**Spec:** [[base-price-never-above-msrp]] · **Owner:** [[../functions/retention]]

**Why this matters:** the simple root fix for the "baseline over-counted" class (Lisa Baker `fdc1d5e3`). **Base price** = the per-unit price *before* the 25% S&S discount + quantity breaks (`price_override_cents`); it must **never exceed MSRP**. `inferAppstleLineBase` sometimes infers a base above MSRP → the engine prices too high → `pricing_preserved` fails. Fix: enforce base ≤ MSRP on migration write + clamp/reject in `price_reconcile` + drop stranded over-MSRP overrides (Lisa → engine derives the correct $110.34 from an MSRP base). **Queue after migration-shipping-protection + migration-fix-remove-line merge.** Extends [[migration-fix-agent]].

## Active project — Migration-Fix: Remove a Line Item ⏳

**Spec:** [[migration-fix-remove-line]] · **Owner:** [[../functions/retention]]

**Why this matters:** the migration-fix agent can't delete a line from `items[]`, so a migration that drags a **free/promo line** across (a $0 ACV Gummies add-on with no catalog variant) fails `items_on_uuids` and can't be repaired (`variant_backfill` keeps it; nothing removes it). Adds a `remove_line` fix_kind + a remove-vs-backfill skill rule. First use: sub `e4589de9` (audit `4b831caa`) — `remove_line` the free ACV Gummies **and** `shipping_protection_convert` ($3.95) → renews $63.91. Queue **after** [[migration-shipping-protection]] merges (both touch `migration-fix.ts`). Extends [[migration-fix-agent]].

## Active project — Migration: Shipping Protection 🚧

**Spec:** [[migration-shipping-protection]] · **Owner:** [[../functions/retention]]

**Why this matters:** Appstle bills shipping protection as a **line item**; internal subs use a **flag** (`shipping_protection_added` + `_amount_cents`, billed separately). `migrate-to-internal` never converts it, so the protection line lands in `items[]` and `pre_migration_charge_cents` over-counts → `pricing_preserved` fails on every protection-carrying migration, and no mechanical fix can wire the columns (stuck sub `4b831caa`). Fix: (1) migration converts the protection line → flag + excludes it from the baseline; (2) a new `shipping_protection_convert` migration-fix `fix_kind` so the agent repairs stuck subs (first use: `4b831caa` — flag $3.75/375¢, baseline 6371¢→5996¢, Tabs override untouched). Extends [[migration-fix-agent]].

## Active project — Spec-Test Classification (no phantom regressions) ✅

**Spec:** [[spec-test-classification]] · **Owner:** [[../functions/platform]]

**Why this matters:** the spec-test agent marked a check `fail` (→ phantom "Regression") when the feature was correct — the check just needed fault-injection it can't do read-only. Rule: `fail` requires **positive evidence of breakage**; checks needing forced failures / mutations / visual judgment are `needs_human`/`inconclusive`, never `fail`. Regressions + the `issues` verdict are driven only by evidence-backed fails. Extends [[spec-test-agent]].

## Active project — Migration-Fix Plain Question + Inline Answer ⏳

**Spec:** [[migration-fix-human-input]] · **Owner:** [[../functions/retention]]

**Why this matters:** when the migration-fix agent can't auto-fix, it dumps technical jargon and offers no way to respond. This makes it ask **one plain, actionable question** (`needs_input`) and lets the owner **type an answer inline** on `/dashboard/migrations` (reuses `/api/roadmap/answer` → resume → Approve & fix). Out-of-system cases get a one-line instruction. Extends [[migration-fix-agent]].

## Active project — Advertorial Attribution Fix ⏳

**Spec:** [[advertorial-attribution-fix]] · **Owner:** [[../functions/cmo]]

**Why this matters:** the ad scorecard under-counts advertorial/listicle traffic — listicle ads land on a PDP-with-`?angle=`, and `advertorial_page_id` is stamped only on a session's first insert and never re-resolved, so ~72 of 150 recent Meta sessions carry an exact-match advertorial angle but show as plain PDP (true advertorial share ~85%, displayed ~37%). Fix: re-resolve `advertorial_page_id` when null + backfill + align the `meta_attribution_daily`/scorecard resolution. Spend/CPA from Meta unaffected.

## Active project — Spec-Test JSON Robustness ⏳

**Spec:** [[spec-test-json-robustness]] · **Owner:** [[../functions/platform]]

**Why this matters:** a spec-test run produced "agent produced no parseable JSON" (0 checks, no verdict). Strict output contract + a parse/repair re-prompt + an honest `error` terminal state (never a silent 0-check pass) + Developer-page retry. Extends [[spec-test-agent]].

## Active project — Migration-Fix Agent ⏳

**Spec:** [[migration-fix-agent]] · **Owner:** [[../functions/retention]]

**Why this matters:** fixes internal subs stuck in Appstle→internal migration — the ones `verifyMigration`'s mechanical auto-heal can't repair and that land `failed` on `/dashboard/migrations` (a renewal at risk). Fires **on the failure event, not a cron**: a `migration_audits` row going `failed` spins up a `claude -p` Max session that diagnoses the failing checks + attempts the *judgment* fixes (pricing-mismatch reconcile, missing-variant backfill+remap, force-cancel lingering Appstle), gated for the billing mutations, then **re-verifies**. Unfixable → surfaced with a written diagnosis (+ stretch: a proposed code-fix spec). Box-agent family with [[box-escalation-triage]].

## Active project — Comp Subscriptions ⏳

**Spec:** [[comp-subscriptions]] · **Owner:** [[../functions/retention]]

**Why this matters:** free internal subs that ship on schedule (base $0, no saved card) for **employees / influencers / investors / owners** — but **fail-closed**: a $0 renewal only fires if the customer is on the **comp allowlist** (`customers.comp_role`), otherwise it fails (no leaking product). Adds the comp marker + renewal branch (gate → no-PM → no-charge → still fulfill + advance), a no-PM Appstle→internal migration, and a **Customers → Comp Subscriptions** list (grouped by role). Triggered by employee Zach being charged (refunded); migrates him as the first comp sub. Extends [[../lifecycles/subscription-billing.md]].

## Active project — Spec-Test Agent (box QA) ⏳

**Spec:** [[spec-test-agent]] · **Owner:** [[../functions/platform]]

**Why this matters:** a box agent that tests **shipped-but-unverified** specs against their own `## Verification` checklist and reports findings — runs the **non-destructive** checks on the box (repo/`tsc`, `gh` CI, `vercel` deploy+logs+env, DB reads, GET endpoints) and flags anything needing a human (visual/UX, or mutating tests). It **never** marks verified/archives (that owner gate stays) but applies its own **"Agent-tested ✅"** stamp. Reports in a new **Developer → Spec Tests** sidebar page + a board chip + inline on the VerificationCard. Box-agent family with [[box-spec-chat]] · [[box-ticket-improve]] · [[box-escalation-triage]].

## Active project — Spec-Test on Ship ⏳

**Spec:** [[spec-test-on-ship]] · **Owner:** [[../functions/platform]]

**Why this matters:** we ship often, so the daily spec-test cron is too slow — this **fires the QA run the moment a card moves to Shipped** (hook `/api/roadmap/status` for manual flips + `reconcileMergedJobs` for build-driven ships), with a shared dedupe so a build-merge + status tweak + cron don't triple-run. The daily cron becomes a **backlog catch-all** for anything the event missed. Extends [[spec-test-agent]]. (Queue after spec-test-agent P2 merges to avoid a parallel-build conflict.)

## Active project — Improve Agent Account-Fix Actions ✅

**Spec:** [[improve-account-fix-actions]] · **Owner:** [[../functions/platform]]

**Why this matters:** the box Improve agent could *diagnose* a typo'd-duplicate-account login mess (Mindy Freeman, ticket a89dcf76) but couldn't *fix* it — no action to re-point a ticket to the right customer or (re)send a magic login link, so a human did both by hand. **P1 shipped ✅ (#129, 2026-06-20):** `reassign_ticket_customer` + `send_magic_link` as approval-gated Improve actions (box proposes → approve → Improve route executes). **P2 shipped ✅ (2026-06-20):** `link_customer_accounts` (founder/owner-gated dupe-merge, empty-shell-heuristic-guarded) + the escalation-triage solver now auto-catches the duplicate-account pattern (proposes the reassign → magic-link → link set). All phases ✅ — fold next. Extends [[box-ticket-improve]].

## Active project — Improve Queue ⏳

**Spec:** [[improve-queue]] · **Owner:** [[../functions/platform]]

**Why this matters:** fire off several box **Improve** turns, walk away, and see at a glance which ones the box has answered — a `/dashboard/tickets/improve` queue (by the to-dos) that surfaces each ticket-Improve session by `turn_status` (Answered · Needs approval · Thinking… · Error) with a deep-link to the ticket + a nav count badge. Pure read over [[../tables/ticket_improve_chats]], no schema change. Extends [[box-ticket-improve]].

## Active project — Box-hosted Spec Chat ⏳

**Spec:** [[box-spec-chat]] · **Owner:** [[../functions/platform]]

**Why this matters:** moves the spec-authoring chat off the **Anthropic API** and onto the build box as a **long-running, resumable `claude -p` session on Max** — same feature set (new/refine chat → finalize-commit-to-main → save-&-build → verification → cross-device resume), but now with full working-tree `Read`/`Grep` over `docs/brain/` + `src/` and `WebSearch` every turn, at $0 marginal. Each user turn is a concurrency-1 `spec-chat` `agent_jobs` job that resumes the session ([[../tables/roadmap_chats]] gains `box_session_id`/`turn_status`); replies take minutes (accepted) in exchange for grounded, code-aware speccing. Sibling of [[goal-decomposition-engine]] on the same box substrate.

## Active project — Box-hosted Ticket "Improve" Agent ⏳

**Spec:** [[box-ticket-improve]] · **Owner:** [[../functions/platform]]

**Why this matters:** turns the ticket Improve tab into the founder's "fix-this-weird-ticket" terminal chat, productized — a **ticket-bound, resumable `claude -p` Max session** (auto-carries `ticket_id`) with full brain/`src/`/web powers, that **recommends then acts under one approval**: customer actions + internal notes + close/unassign/unescalate, sonnet-rule + grader changes, ticket re-score, and **code changes routed as ticket-sourced specs to the CS manager** (commissioned in Roadmap, never auto-built). Pivotable mid-conversation. Reuses the [[box-spec-chat]] session primitive + the [[build-approval-gates]] `pending_actions` gate; introduces a `cs_manager` role + [[../functions/cs]]. Replies take minutes (accepted), $0 marginal on Max.

## Active project — Box-hosted Escalation Triage ⏳

**Spec:** [[box-escalation-triage]] · **Owner:** [[../functions/platform]]

**Why this matters:** retires the Anthropic-cloud agent-todo routine and replaces it with an **hourly box sweep over escalated tickets** on Max, using a **solver→skeptic→quorum** loop: the solver finds the fix to unescalate (or, if mis-escalated, specs an analyzer fix); a skeptic adversarially re-checks against brain/rules/DB; on agreement it materializes the same human-gated `agent_todos`. Tweaks: **code changes become spec files** (owner=cs, ticket-ref, commissioned on Roadmap — never `code_change` todos), prompt rules stay **admin-approvable so Zach can approve**, and no-quorum leaves the ticket escalated for a human. Bounded-proxy autonomy (proposes, never silently mutates). Includes deleting the old routine so there's no dead code. Box-agent family with [[box-spec-chat]] + [[box-ticket-improve]].

## Active project — PDP Refinement Pass ⏳

**Spec:** [[pdp-refinement-pass]] · **Owner:** [[../functions/cmo]]

**Why this matters:** codifies the hand-tuned Superfood Tabs polish (2026-06-20) into a **repeatable per-product pass** so the founder never re-types it per page. Splits into (A) one-time global code/pipeline upgrades — timeline centering, before/after → 2 stories, 15-vs-16 badge, individual trust pills, full-corpus review-analysis pagination, per-variant Supplement Facts + AI/KB nutrition access, a harvest-from-Shopify-PDP step (real endorsements + before/after photos re-hosted to Supabase), and lifestyle + Nano-Banana static-ad gallery slides — and (B) a box pass that applies them per product from its own PDP/Drive/reviews, plus (C) per-product creative (headline, captions) proposed for approval. Run #1 = Superfood Tabs; then fan out. Extends [[box-product-seeding]].

## Active project — Storefront coupon visibility + WELCOME SMS ⏳

**Spec:** [[storefront-coupon-visibility-and-sms]] · **Owner:** [[../functions/growth]]

**Why this matters:** storefront orders apply the WELCOME discount but never write it to `orders.discount_codes` (it's only in `payment_details`), so the AI reads "no discounts applied" and agrees to refund discounts the customer already got. Plus the WELCOME code SMS sits at `queued` and never delivers, so customers think the discount failed. Surfaced by ticket 8e9e325e (Harvey Kletz). Three fixes: persist+surface the coupon on the order, make the AI verify discount claims against order data, and fix queued-SMS delivery + email fallback.

## Active project — Spec lifecycle + archival ⏳

**Spec:** [[spec-lifecycle-and-archival]]

**Why this matters:** adds a **Verified** gate (distinct from Shipped) + clean archival so shipped specs don't sit on the board forever. Verify → fold into the brain + an archive-index entry + `git rm` the spec (git is the immutable archive) → re-hydratable into a fresh spec from the current brain. Changes the [[../project-management]] convention. Pairs with the new [[../dashboard/brain]] reader.

## Active project 1 — Storefront 🚧

**Lifecycle:** [[../lifecycles/storefront-checkout]]

**Why this matters:** owning the checkout removes the 3% Shopify txn fee, unlocks AOV boosters + custom sub-conversion logic, and prevents the hidden-parallel-sub pattern that bites us repeatedly.

**Feedback surface:** bugs + structural gaps this project surfaces in tickets route back through the [[../lifecycles/agent-todo-system]] queue (now shipped — [[../lifecycles/agent-todo-system]]) as `code_change` / `brain_doc_edit` todos.

**Sub-phases shipped:**
- PDP pixel, cart create + server-validated pricing
- Braintree Hosted Fields checkout
- Avalara tax quote at checkout (recent)
- OTP gate (`/api/checkout/otp/{start,verify,resend}`)
- Subscription choice card (`/api/checkout/existing-subs`)
- CAPI fan-out

**Open sub-work:**
- ✅ **Checkout customize-bypass** — shipped + verified 2026-06-18, folded into [[../lifecycles/storefront-checkout]] (Phase 3) + archived ([[../archive]]). Pack-select goes straight to /checkout (skipping /customize); "Customize your order" button on checkout is the opt-in editor. `add_to_cart`/CAPI unaffected (fires at pack-select); `checkout_view` guarded once-per-token. Gated on `workspaces.storefront_skip_customize` (on for Superfoods, A/B-toggleable).
- 🚧 **OTP testing** — flow built, awaiting Dylan to test end-to-end on the live storefront.
- ✅ **New-sub vs add-to-existing-sub UI** — shipped (Phase 4.6 in [[../lifecycles/storefront-checkout]]). Three-way choice card (`new_sub` / `add_to_sub` / `renewal_only`) shows when an OTP-verified customer with an active **internal** sub buys a subscribe item. Prevents the "Jennifer Santiago = 2 parallel Superfood Tabs subs" pattern.
- ⏳ **Combine-into-sub: Appstle targets + migrate-on-combine** — the next refinement. **Today is safe but conservative:** `/api/checkout/existing-subs` filters `is_internal=true`, so an Appstle sub is never a combine target (and `appendCartItemsToSub` hard-refuses non-internal subs). Net invariant — *combining always ends in an internal sub* — already holds; the only cost is a customer whose sole sub is Appstle sees no combine card and creates a parallel internal sub (the post-checkout sweep migrates the Appstle one separately → two internal subs). **The deferred work:** surface Appstle subs as combine targets too, and honor the invariant by migrating. Rules (settled with Dylan 2026-06-14): `renewal_only` (no charge / no fresh PM) → **internal targets only**; `add_to_sub` ("order now + add", vaults a card) → may target an Appstle sub by calling `migrateCustomerAppstleSubsToInternal(ws, customer)` **before** `appendCartItemsToSub` (PM is already vaulted by that point, so `findBillableCustomer` succeeds and the flip makes the sub internal → append works). Touch points: `existing-subs` route (return Appstle subs + an `is_internal`/type flag), `CheckoutClient.tsx` (per-target: Appstle ⇒ only "order now + add", disable "next renewal only" with a note), `checkout/route.ts` add_to_sub branch (migrate-first ordering), defense-in-depth guard rejecting `renewal_only` against a non-internal target. **Open UX fork (unasked):** for an Appstle target, order-now-only+migrate (recommended) vs. allow renewal-only via saved default card vs. keep hidden. Promote to its own spec when picked up: `specs/checkout-combine-appstle-migrate.md`.
- ✅ **Survey chapter + converter-first PDP reorder** — verified + archived 2026-06-18 ([[../archive]]). Shipped as a personalized **survey recommender** chapter (one question per screen → inline `PriceCard`/`BundleCard` recommendation, optional email→phone unlock applying the popup discount on-page) plus the converter-first chapter reorder (why-this-works + ingredients above price; low-reach detail chapters relocated below price as opt-in "learn more"). Canonical home: [[../lifecycles/storefront-checkout]] § Survey chapter (recommender).
- ✅ **Shopify theme management via ShopCX (AI-driven, short-term)** — verified + archived 2026-06-18 ([[../archive]]). Chat→build theme edits ship to the live store via GitHub commits (Option A); Shopify's GitHub integration auto-deploys. `src/lib/shopify-theme.ts` (Shopify read + GitHub commit) + `scripts/reconcile-shopify-theme.ts`. Reconciliation run: 32 genuinely-drifted files committed to catch the repo up to live, re-run shows 0 diff. Canonical home: [[../recipes/edit-shopify-theme]] + [[../libraries/shopify-theme]] + [[../integrations/shopify]] § Theme management.
- ✅ **Homepage rebuild (direct-response, Tabs-led)** — verified + archived 2026-06-18 ([[../archive]]). Shopify homepage rebuilt as a trust-and-routing engine for ad-aware brand searchers + repeat reorderers: 9 custom `dr-*` sections (hero = Superfood Tabs, full-catalog merchandising incl. non-advertised Ashwavana Zen Relax + Creatine Prime+, 30-day MBG, ABC/CBS/NBC/FOX press bar as theme assets), staged on a `homepage-rebuild` preview branch (`ensureBranch`) with auto-sourced images (zero uploads). Canonical home: [[../recipes/edit-shopify-theme]] § Staging a big change.

---

**Cross-cutting (storefront × ad builder):**
- ✅ **Ad & Lander Quality Scorecard** — shipped 2026-06-17, folded into [[../dashboard/storefront__ad-scorecard]]. Ranks ad creatives (by `utm_campaign`/`utm_content`) and lander variants (by `landing_url` variant/angle) on traffic quality — engaged/ATC/lead/purchase rates, revenue, CVR, composite score — the feedback instrument for [[killer-statics]] + [[../lifecycles/advertorial-landers]]. Future roadmap (Meta spend/ROAS, ad×lander cross-tab, lander-id persistence) tracked in that dashboard page's "Future / open work".
- ✅ **Auto-generated advertorial landers** — verified + archived 2026-06-18 ([[../archive]]). When an ad campaign hits `ready`, auto-generates a matched lander (per ad *angle*, three variants: advertorial · before/after · "8 Reasons Why") reusing the ad's assets + the PDP's working sections; zero manual design, scent-match by construction; targets the 86%→24% hero cliff. Canonical home: [[../lifecycles/advertorial-landers]] + [[../tables/advertorial_pages]].

## Active project 2 — Customer portal 🚧

**Lifecycle:** [[../lifecycles/customer-portal]]

**Why this matters:** the in-house portal is replacing the Shopify-extension surface. Once it owns full sub-management it can do things the Shopify ext can't — better cancel-save UX, in-portal storefront flows, loyalty redemption, payment update without leaving the page.

**Feedback surface:** portal bugs + gaps surfaced in tickets route back through the [[../lifecycles/agent-todo-system]] queue (now shipped — [[../lifecycles/agent-todo-system]]) as `code_change` / `brain_doc_edit` todos.

**Sub-phases shipped (per lifecycle page):**
- Both surfaces (Shopify extension + in-house mini-site) wired
- Cancel-via-journey, loyalty redeem + apply, coupon validation
- Address + frequency + line-item mutations
- Payment-method update with Appstle → internal migration on card change
- Identity linking, event log + internal ticket notes

**MVP hardening shipped (2026-06-10):** account linked-accounts list + email read-only, first-delivery mutation gate (both portals), support sidebar tickets across linked accounts (archived read-only), payment-recovery magic-link emails + dunning visibility. The in-house portal is **adequately hardened for MVP**.

**Open sub-work:**
- ✅ **Portal account handoff + login chat + Help Center** — **shipped 2026-06-17**, folded into [[../lifecycles/customer-portal]] (spec deleted). `portal.superfoodscompany.com` is now the single account destination. The Shopify theme account drawer **and** `/pages/portal` (theme app extension, deployed `shopcx-98`) redirect to the portal — logged-in via the App-Proxy SSO route (`/api/portal?route=sso` mints a magic-link from the verified `logged_in_customer_id`, no second login); logged-out → bare portal. Drawer redesigned to one CTA + capability showcase. Login page has the anonymous live-chat widget (login-help). New searchable **Help Center** sidebar (product cards + General). Plus orders-list cleanups (hide stale "Processing", fix $0.00 line items).
- ✅ **Portal: "Resources" sidebar** — verified + archived 2026-06-18 ([[../archive]]). 36 blog articles imported → [[../tables/posts]] (35 product resources), images migrated off Shopify, AI-classified (product + grouping), portal Resources UI live (search + product→grouping + reader), **public storefront blog** live. Import ran as a 36-agent workflow. Canonical home: [[../lifecycles/blog-resources]]. Remaining = future phases (RAG embedding for AI citations, periodic re-sync).
- ⏳ **Portal: add "Promotions" sidebar item** — net-new sidebar section for active promotions/offers. (Later session.)
- ⏳ **Portal: add "Shop" sidebar item** — net-new sidebar section for in-portal shopping (re-order / add products without leaving the portal). (Later session.)
- 🚧 **New customer portal** (v2) — net-new surface being built. Scope to be spec'd: which capabilities move from the Shopify ext to the in-house surface, what the design system looks like, how it co-exists with the existing in-house mini-site under `/portal`. Promote to its own spec when concrete: `specs/customer-portal-v2.md`.
- ✅ **Appstle pricing heal + migration monitor** — **verified + archived 2026-06-18** ([[../archive]]). One Appstle gateway that heals `pricingPolicy:null` subs on touch, smart migration that reads `pricingPolicy.basePrice` directly (heal-by-migration), and a post-payment-method verification monitor (retry-then-flag). Folded → [[../lifecycles/subscription-billing]] § Migration path, [[../libraries/appstle-pricing]], [[../libraries/migration-audit]], [[../tables/migration_audits]], [[../inngest/migration-audit-retry]], [[../inngest/migration-integrity-sweep]], [[../dashboard/migrations]].

---

## Active project 3 — Ad builder tool 🚧

**Lifecycle:** [[../lifecycles/ad-render]]

**Why this matters:** cut per-ad creative cost from ~$200 (freelancer) to ~$2 (Higgsfield + Whisper + Anthropic), and cut turnaround from days to ~5 minutes per ad. Enables ROAS-driven creative iteration at the cadence the Meta dashboard needs.

**Sub-phases shipped (per lifecycle page):**
- Schema: [[../tables/ad_avatars]], [[../tables/ad_avatar_proposals]], [[../tables/ad_campaigns]], [[../tables/ad_videos]], [[../tables/ad_jobs]], [[../tables/product_ad_angles]]
- Product-asset prep: `product_variants.isolated_image_url` + `physical_dimensions` columns + UI uploads on `/dashboard/storefront/products/[id]`
- Libraries: ad-angles, ad-script, ad-validator, ad-render, ad-tool-config, ad-avatar-proposals, ad-transcribe, ad-storage, higgsfield
- API surface: `/api/ads/*` (campaigns, avatars, angles, proposals, validate, hero/audio/talking-head/render) + `/api/workspaces/{id}/ad-tool-settings`
- Dashboard: `/dashboard/marketing/ads/*`

**Shipped since (2026-06): the proven model stack + creative library**
- Gemini engine wired: Nano Banana Pro hero, Veo 3.1 Fast talking heads + b-roll, Lyria music. TTS dropped (VO = Veo native audio).
- Creative library ([[../tables/ad_segments]] + `ad_campaigns.composition`): every piece persisted + reusable; staged Production UI; per-clip refresh + HQ-Veo-3 regenerate; b-roll studio (text / animate-photo / reuse-from-library, keep/discard); Gemini settings card. First real ad built + saved.
- ✅ **Production render runtime → Remotion Lambda (2026-06-05)** — render runs on AWS Lambda (Vercel serverless can't run Remotion); Whisper transcription folded into the render so captions never come back empty; durable re-signed URLs. Provisioned + verified (ad rendered on Lambda in ~39s). Folded into [[../lifecycles/ad-render]] + [[../integrations/remotion-lambda]]; spec deleted.

- ✅ **Static ads — separate design-led process (2026-06-05)** — three designed archetypes (review screenshot · offer card · benefit/authority), hybrid engine, rendered on Lambda across 1:1/4:5/9:16 from product intelligence. Verified in-app (Inngest → Lambda). Folded into [[../lifecycles/ad-static]]; spec deleted.

**Open sub-work:**
- 🚧 **Killer statics — cold-50+ archetypes, both formats** — [[killer-statics]] (code-complete + typechecked on branch `killer-statics-iso`; remaining ops = apply the landing_url migration, redeploy the Lambda site, verify a render, run `scripts/seed-killer-statics.ts`, Dylan design pass). Replaces the loud brutalist `AdStatic` with a trust-first archetype system (advertorial editorial serif · testimonial · authority · big-claim · before/after), rendered 4:5 **and** 9:16 (safe-zone aware), auto-built from PI + existing ad assets, audience-aware selection, + the Lambda static-image fix. **Copy rules:** anchor angles to weight/aging/best-self/social (never energy/no-crash); review counts = actual + 10,000; use real `product_media` assets (real endorser photo, real before/after).
- ✅ **Publish ads to Meta (2026-06-10)** — campaign-page "Publish to Meta": generate copy (4 headlines + 4 primary texts + CTA), pick page → ad account → campaign → ad set, upload video → creative (dynamic) → ad (PAUSED default). `src/lib/meta-ads.ts` + `ad-meta-copy.ts` + `ad_publish_jobs` + Inngest `adToolPublishToMeta`. Read-side verified live. Folded into [[../lifecycles/ad-publish]]; spec deleted.
- ⏳ **TODO (Dylan): static-ad design tweaks** — the static pipeline ships, but the *visual design* of the three archetypes is a first pass and needs Dylan's review/iteration. All visual changes live in `remotion/StaticAds.tsx` + `DEFAULT_BRAND` (`src/lib/ad-static.ts`); preview via sample render, then re-run `scripts/deploy-remotion-lambda.ts`. Details + checklist in [[../lifecycles/ad-static]] § Status / open work.
- Minor: NBP backdrop auto-gen for offer cards; editable-copy UI before static render; native/UGC archetype; only talking beats refreshable via UI ([[../lifecycles/ad-render]] / [[../lifecycles/ad-static]] § Open).

---

## Reference / runbooks (not work items)

- **DB lockup diagnosis runbook** — past root cause was missing index on `sms_campaign_recipients.message_sid` during MDW SMS sends. Use `scripts/pg-stat-statements.ts` + `scripts/pg-live-snapshot.ts` against the pooler. Should move to `docs/brain/recipes/db-lockup-diagnosis.md` next pass.

---

## Past incident (kept for pattern-matching)

- **Apr 13 ticket glitch** — false-positive close + return response + 529 errors. Originally in `project_ticket_glitch_apr13.md`. If it recurs, check that file before re-investigating from scratch.

---

## Recently shipped (delete from this index after the next pass)

- ✅ **Agent To-Do system** (2026-06-08) — live end-to-end: the hourly routine reasons over escalated tickets, proposes todos into the `/dashboard/tickets/todos` approval queue, customer-facing approvals execute via the Inngest worker, and system-level todos open `claude/*` PRs that owners squash-merge from `/dashboard/branches`. The common feedback surface for the other projects. Now in [[../lifecycles/agent-todo-system]]; spec folded + deleted.
- ✅ **Prompt-learning auto-review** (2026-06-03) — now in [[../lifecycles/ai-learning]].
- ✅ **Demographic enrichment lifecycle** (2026-06-03) — now in [[../lifecycles/demographic-enrichment]].
- ✅ **Product Intelligence Engine, ShopGrowth removal** (2026-06-03) — now in [[../lifecycles/product-intelligence]].
- ✅ **CSAT** (2026-06) — now in [[../lifecycles/csat]].
- ✅ **Customer voice / operational rules / UI conventions** brain pages (2026-06).
- ✅ **Email tracking spec** — mostly shipped; verify current state in [[../inngest/deliver-pending-send]] / Resend integration page if anyone touches it again.
- ✅ **Stuck-sub cleanup** (2026-06-03) — `next_billing_date` cleanup across 83 subs: 75 advanced (Appstle truth synced into our DB), 6 marked cancelled, 2 re-fired into dunning via `appstleAttemptBilling`. Was a one-time data-staleness backlog, not an active bug. Script: `scripts/cleanup-stuck-subs-2026-06-03.ts`.
- ✅ **Cancel-event dedup** (2026-06-03) — forward fix in the Appstle webhook handler. When a customer cancels via the portal, the Appstle webhook checks for a portal cancel for the same `shopify_contract_id` within the last 5 min and suppresses the duplicate insert. Historical 272 duplicates left in place; analytics consumers can dedupe at query time if needed.
- ✅ **Stacked-sale-coupon check** (2026-06-03) — re-scoped to "subs with 2+ sale coupons (excluding loyalty / free-shipping / Buy-N bundle)." Live count: 0.
- ✅ **Auto-grant detection removed** (2026-06-03) — three stubbed triggers (`cancelled_but_charged` / `duplicate_charge` / `never_delivered`) never wired up. Sonnet escalates these directly when they occur; `never_delivered` is handled by the replacement flow. Stripped the executor code path + UI editor + simulate route.
- ✅ **Meta ad-comment attribution** — shipped via `effective_object_story_id` / `effective_instagram_media_id` match against the webhook's `post.id` / `media.id`.
- ✅ **Klaviyo 180d engagement backfill** — shipped via local script.
- ✅ **UX/product bucket** — parallel-sub alert (superseded by add-to-existing-sub UI in the storefront project), SMS phone preview, SMS buyer archetypes + replenishment ratio, predicted-purchase segments, return-request auto-playbook (via refund playbook), shipping-issues Opus chat.
- ✅ **Analytics + integrations bucket** — ROAS analytics, billing forecast, Amazon pricing UI, anomaly-aware data tools (via ticket timeline anomaly-detection); automation analytics dashboard + cross-app shared keys marked not needed.

---

## Related

[[../project-management]] · [[../README]]
