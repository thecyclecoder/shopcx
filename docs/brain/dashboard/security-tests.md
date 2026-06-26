# dashboard/security-tests

The owner-only **Security tests** log — every security review **Vault** (the [[../libraries/security-agent|security-review agent]], persona 🔒) has run on a merged spec build, clean ones included. North star ([[../operational-rules]] § supervisable autonomy): auto-merge optimizes "ship the fix"; its degenerate state is shipping a fix that opens an injection / secret-leak / authz hole. Vault is the security supervisor **above** that proxy — she reviews every merged diff **read-only** and **escalates**, never auto-mutates. This page is the audit log of her verdicts.

**Route:** `/dashboard/developer/security-tests` (client poller, owner-only, 20s)
**Sidebar:** **Developer** section (owner-only) → **Security tests** (right under [[control-tower|Regressions]]), with a **rose badge** = surfaced findings awaiting the owner (a routed real-vuln fix or a needs-human finding).

## Surfaces

- **Header summary** — total reviews · clean · "needs attention", plus a rose chip when any finding is open.
- **The log** — one **card** per review ([[../tables/agent_jobs]] `kind='security-review'`), newest-first, each carrying:
  - a **verdict** badge — `clean` · `false-positive` · `real-vuln` · `needs-human` · `running` · `failed`. A surfaced job's verdict comes from its status (`needs_approval`+a `security_build` action ⇒ real-vuln; `needs_attention` ⇒ needs-human); a `completed` job's verdict is parsed off the `log_tail` prefix (`clean`/`false-positive`).
  - a **mode** chip (**Diff review** = the per-merge review, fired on every merged `claude/*` PR; **Dependency scan** = the daily `npm audit` dep-watch), the **PR #** when present, and the time.
  - **what was reviewed** — the reviewed spec's title (resolved from [[../tables/specs]]) + its slug.
  - the **finding** — Vault's plain-text classification (`log_tail`), collapsible (the verdict prefix is stripped, it's already the badge).
  - for a **routed real-vuln**, a callout with the **authored fix spec** (deep-links to its [[roadmap|roadmap card]]) + a **decide in Approvals →** link — the fix's Build is decided on the [[approvals|Approvals]] page (the unchanged routed-approval path), never here.
- **Filters** — a segmented control (**All reviews · Needs attention · Clean**, with live counts) + a text filter + Refresh.

This page is **read-only** — it never decides a fix (that's [[approvals]]) and never mutates a review. It only logs what Vault found.

## Data source

- `GET /api/developer/security-tests` (`src/app/api/developer/security-tests/route.ts`, owner-gated) → [[../libraries/security-agent]] `listSecurityReviews(admin, workspaceId)` → `{ items: SecurityReviewLogItem[] }` (the full log, spec-title-enriched, verdict-derived).
- `GET /api/developer/security-tests?count=1` → `{ surfacedCount }` (`countOpenSecurityReviews`) — the lightweight path the always-mounted sidebar polls for the badge (surfaced = `needs_approval`/`needs_attention`; clean reviews never count).

## Relationship to the build lifecycle

Security is **stage 4** of the 5-node build lifecycle (Spec Review → Build → Spec Test → **Security** → Fold — [[../libraries/build-lifecycle]]). The same per-spec rollup ([[../libraries/security-agent]] `getSecurityStateBySlug`) drives both the timeline's Security node ([[roadmap|LifecycleTimeline]]) and the **auto-fold gate** (a spec can't fold until its security review is `done`). This page is the **flat, founder-facing log** across all specs; the timeline is the per-spec view.

## Related

[[../libraries/security-agent]] · [[../inngest/security-dep-watch]] · [[../libraries/build-lifecycle]] · [[approvals]] · [[control-tower]] · [[../tables/agent_jobs]] · [[../tables/specs]] · [[../tables/director_activity]] · [[agents]] · [[../specs/security-dependency-agent]] · [[../operational-rules]] (§ North star — supervisable autonomy)
