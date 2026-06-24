/**
 * Agent personas — the reusable director-persona design-system config
 * (agents-hub-role-inboxes spec, Phase 2; profile photos seeded 2026-06-23).
 *
 * ONE reskinnable source of truth for the org-chart cast: each function slug (directors)
 * or agent_jobs kind (workers) → a persona (name · role · color · personality · photo).
 * Keyed by the brain `functions/*.md` slug (+ the special `ceo` seat) and the worker
 * `agent_jobs` kinds, so a NEW director/worker inherits a persona by adding one entry —
 * every surface reads this, so names/photos/colors are never hardcoded across components.
 *
 * Photos live in the public `agent-avatars` Supabase bucket (crafted via Nano Banana Pro);
 * `avatarUrl` is the real headshot, `mascotId` the inline-SVG fallback when no photo.
 * Pure config (no server imports) → safe to import from client components.
 */

const AV = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/agent-avatars/";

export type MascotId = "ada" | "max" | "iris" | "june" | "theo" | "ceo" | "default";

export interface AgentPersona {
  /** function slug (e.g. "platform"), agent_jobs kind (e.g. "repair"), or "ceo" */
  key: string;
  /** the character name — reskinnable */
  name: string;
  /** display role label (the org-chart seat) */
  role: string;
  /** quick emoji fallback (the goal's shorthand) */
  emoji: string;
  /** one-line voice for the board posts (M3 reuses this) */
  personality: string;
  /**
   * The precise responsibility list rendered on the role's profile page
   * (Phase 5). Workers carry the MOST precise list (their exact mandate);
   * directors + the CEO derive theirs from the brain (mandates / goals), so
   * this is populated for the worker cast only — see RESPONSIBILITIES below.
   */
  responsibilities?: string[];
  /** which inline SVG mascot to render (fallback when no avatarUrl) */
  mascotId: MascotId;
  /** real headshot URL (public agent-avatars bucket) — preferred over the mascot */
  avatarUrl?: string;
  /** chip classes — bg + text + border (explicit so Tailwind keeps them) */
  chip: string;
  /** accent dot / badge background */
  dot: string;
  /** mascot tile background ring */
  ring: string;
  /** accent text color for the mascot (inherited via currentColor) */
  accent: string;
}

/**
 * The cast. Directors keyed by function slug + the `ceo` seat; Platform workers keyed by
 * their `agent_jobs` kind. Reskin by editing this map. Colors are explicit class strings.
 */
export const PERSONAS: Record<string, AgentPersona> = {
  ceo: {
    key: "ceo", name: "Henry", role: "CEO", emoji: "👑",
    personality: "Owns the company objectives — reads one inbox, not N surfaces.",
    mascotId: "ceo", avatarUrl: `${AV}ceo-crown.jpg`,
    chip: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900/40",
    dot: "bg-amber-500", ring: "bg-amber-50 dark:bg-amber-900/20", accent: "text-amber-600 dark:text-amber-400",
  },
  // ── Directors (function slugs) ──────────────────────────────────────────────
  platform: {
    key: "platform", name: "Ada", role: "Platform", emoji: "🛠️",
    personality: "Steady, blunt, ships fast — squashes 500s and escorts builds to green.",
    mascotId: "ada", avatarUrl: `${AV}ada-platform.jpg?v=2`,
    chip: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-900/40",
    dot: "bg-indigo-500", ring: "bg-indigo-50 dark:bg-indigo-900/20", accent: "text-indigo-600 dark:text-indigo-400",
  },
  growth: {
    key: "growth", name: "Max", role: "Growth", emoji: "🚀",
    personality: "High-energy experimenter — always testing the next acquisition lever.",
    mascotId: "max", avatarUrl: `${AV}max-growth.jpg`,
    chip: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-900/40",
    dot: "bg-emerald-500", ring: "bg-emerald-50 dark:bg-emerald-900/20", accent: "text-emerald-600 dark:text-emerald-400",
  },
  cmo: {
    key: "cmo", name: "Iris", role: "CMO", emoji: "🎨",
    personality: "Brand-obsessed storyteller — owns the owned + organic voice.",
    mascotId: "iris", avatarUrl: `${AV}iris-cmo.jpg`,
    chip: "bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-900/40",
    dot: "bg-pink-500", ring: "bg-pink-50 dark:bg-pink-900/20", accent: "text-pink-600 dark:text-pink-400",
  },
  cs: {
    key: "cs", name: "June", role: "CS", emoji: "💬",
    personality: "Warm, fast, customer-first — turns tickets into product fixes.",
    mascotId: "june", avatarUrl: `${AV}june-cs.jpg`,
    chip: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-900/40",
    dot: "bg-sky-500", ring: "bg-sky-50 dark:bg-sky-900/20", accent: "text-sky-600 dark:text-sky-400",
  },
  retention: {
    key: "retention", name: "Theo", role: "Retention", emoji: "🧲",
    personality: "Calm closer — keeps people subscribed, recovers the dunning saves.",
    mascotId: "theo", avatarUrl: `${AV}theo-retention.jpg`,
    chip: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-900/40",
    dot: "bg-violet-500", ring: "bg-violet-50 dark:bg-violet-900/20", accent: "text-violet-600 dark:text-violet-400",
  },
  // ── Platform workers (agent_jobs kinds) — report to Ada/Platform ─────────────
  repair: {
    key: "repair", name: "Rafa", role: "Repair", emoji: "🟢",
    personality: "Triages every error, root-causes, dismisses noise, authors the fix.",
    mascotId: "default", avatarUrl: `${AV}rafa-repair.jpg`,
    chip: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-900/40",
    dot: "bg-green-500", ring: "bg-green-50 dark:bg-green-900/20", accent: "text-green-600 dark:text-green-400",
  },
  regression: {
    key: "regression", name: "Remi", role: "Regression", emoji: "🔴",
    personality: "Reviews regressions, dismisses false ones, authors fix specs directly.",
    mascotId: "default", avatarUrl: `${AV}remi-regression.jpg`,
    chip: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-900/40",
    dot: "bg-red-500", ring: "bg-red-50 dark:bg-red-900/20", accent: "text-red-600 dark:text-red-400",
  },
  "security-review": {
    key: "security-review", name: "Vault", role: "Security", emoji: "🔒",
    personality: "Reviews every merged diff for vulns, watches deps for CVEs, escalates — never auto-mutates.",
    mascotId: "default", avatarUrl: `${AV}vault-security.jpg`,
    chip: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900/40",
    dot: "bg-amber-500", ring: "bg-amber-50 dark:bg-amber-900/20", accent: "text-amber-600 dark:text-amber-400",
  },
  "spec-drift": {
    key: "spec-drift", name: "Reese", role: "Spec Drift", emoji: "🔄",
    personality: "The DB-vs-code backstop — for every phase the DB marks shipped, checks its code is actually on main, and surfaces a bad/reverted merge for the director to escalate.",
    mascotId: "default", avatarUrl: `${AV}reese-specdrift.jpg`,
    chip: "bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:border-cyan-900/40",
    dot: "bg-cyan-500", ring: "bg-cyan-50 dark:bg-cyan-900/20", accent: "text-cyan-600 dark:text-cyan-400",
  },
  db_health: {
    key: "db_health", name: "Devi", role: "DB Health", emoji: "🔵",
    personality: "Watches slow queries + growth, EXPLAIN-diagnoses, proposes the index.",
    mascotId: "default", avatarUrl: `${AV}devi-dbhealth.jpg`,
    chip: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-900/40",
    dot: "bg-blue-500", ring: "bg-blue-50 dark:bg-blue-900/20", accent: "text-blue-600 dark:text-blue-400",
  },
  "coverage-register": {
    key: "coverage-register", name: "Cole", role: "Coverage", emoji: "🟦",
    personality: "Catches unregistered loops, proposes the MONITORED_LOOPS entry.",
    mascotId: "default", avatarUrl: `${AV}cole-coverage.jpg`,
    chip: "bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:border-cyan-900/40",
    dot: "bg-cyan-500", ring: "bg-cyan-50 dark:bg-cyan-900/20", accent: "text-cyan-600 dark:text-cyan-400",
  },
  "spec-test": {
    key: "spec-test", name: "Vera", role: "Verification", emoji: "🟡",
    personality: "Verifies shipped specs hold, catches false-✅ + drift, flags regressions.",
    mascotId: "default", avatarUrl: `${AV}vera-verify.jpg`,
    chip: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-900/40",
    dot: "bg-yellow-500", ring: "bg-yellow-50 dark:bg-yellow-900/20", accent: "text-yellow-600 dark:text-yellow-400",
  },
  build: {
    key: "build", name: "Bo", role: "Build", emoji: "🟠",
    personality: "Claims build jobs, builds on the box, keeps tsc clean, opens PRs.",
    mascotId: "default", avatarUrl: `${AV}bo-build.jpg`,
    chip: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-900/40",
    dot: "bg-orange-500", ring: "bg-orange-50 dark:bg-orange-900/20", accent: "text-orange-600 dark:text-orange-400",
  },
  "migration-fix": {
    key: "migration-fix", name: "Mira", role: "Migrations", emoji: "🟢",
    personality: "Applies + repairs migrations, reconciles file drift vs the live DB.",
    mascotId: "default", avatarUrl: `${AV}mira-migrations.jpg`,
    chip: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-900/40",
    dot: "bg-teal-500", ring: "bg-teal-50 dark:bg-teal-900/20", accent: "text-teal-600 dark:text-teal-400",
  },
  "pr-resolve": {
    key: "pr-resolve", name: "Pax", role: "PR-Resolve", emoji: "⬜",
    personality: "Resolves dirty/conflicted PRs, dedupes, keeps the merge queue clean.",
    mascotId: "default", avatarUrl: `${AV}pax-prresolve.jpg`,
    chip: "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    dot: "bg-slate-500", ring: "bg-slate-50 dark:bg-slate-800/40", accent: "text-slate-600 dark:text-slate-400",
  },
  fold: {
    key: "fold", name: "Fenn", role: "Fold / Docs", emoji: "🟤",
    personality: "Folds shipped specs into the brain + archives — keeps it canonical.",
    mascotId: "default", avatarUrl: `${AV}fenn-fold.jpg`,
    chip: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-900/40",
    dot: "bg-amber-700", ring: "bg-amber-50 dark:bg-amber-900/20", accent: "text-amber-700 dark:text-amber-300",
  },
  monitor: {
    key: "monitor", name: "Tao", role: "Control Tower", emoji: "🔷",
    personality: "Watches heartbeats/loops/errors, raises alerts, feeds error→repair.",
    mascotId: "default", avatarUrl: `${AV}tao-monitor.jpg`,
    chip: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-900/40",
    dot: "bg-blue-600", ring: "bg-blue-50 dark:bg-blue-900/20", accent: "text-blue-700 dark:text-blue-300",
  },
  plan: {
    key: "plan", name: "Pia", role: "Planner", emoji: "🟣",
    personality: "Decomposes goals into milestone→spec trees with blocked_by deps.",
    mascotId: "default", avatarUrl: `${AV}pia-planner.jpg`,
    chip: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-900/40",
    dot: "bg-purple-500", ring: "bg-purple-50 dark:bg-purple-900/20", accent: "text-purple-600 dark:text-purple-400",
  },
  "product-seed": {
    key: "product-seed", name: "Sol", role: "Product Seeding", emoji: "🩷",
    personality: "Takes a product from nothing to published — pulls intel, builds the page, ships the catalog row.",
    mascotId: "default", avatarUrl: `${AV}sol-productseed.jpg`,
    chip: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-900/40",
    dot: "bg-rose-500", ring: "bg-rose-50 dark:bg-rose-900/20", accent: "text-rose-600 dark:text-rose-400",
  },
  "spec-chat": {
    key: "spec-chat", name: "Sage", role: "Spec Chat", emoji: "🟪",
    personality: "Answers spec questions on the roadmap and turns the chat into authored spec edits.",
    mascotId: "default", avatarUrl: `${AV}sage-specchat.jpg`,
    chip: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-900/40",
    dot: "bg-indigo-500", ring: "bg-indigo-50 dark:bg-indigo-900/20", accent: "text-indigo-600 dark:text-indigo-400",
  },
  "dev-ask": {
    key: "dev-ask", name: "Dex", role: "Dev Q&A", emoji: "🟩",
    personality: "Answers read-only 'why / how / is it working' developer questions from the message center.",
    mascotId: "default", avatarUrl: `${AV}dex-devask.jpg`,
    chip: "bg-lime-100 text-lime-800 border-lime-200 dark:bg-lime-900/30 dark:text-lime-300 dark:border-lime-900/40",
    dot: "bg-lime-500", ring: "bg-lime-50 dark:bg-lime-900/20", accent: "text-lime-600 dark:text-lime-400",
  },
};

/**
 * Precise per-worker responsibility lists (Phase 5 — the profile detail page).
 * Keyed by `agent_jobs` kind (the box lane). Workers carry the MOST precise list —
 * their exact mandate — while directors/CEO derive responsibilities from the brain
 * (`functions/*.md` mandates / `goals/*.md`). Reskinnable here in one place.
 */
const RESPONSIBILITIES: Record<string, string[]> = {
  repair: [
    "Triage every inbound error the Control Tower raises",
    "Root-cause the failure, not just the symptom",
    "Dismiss foreign / transient / already-fixed errors as noise",
    "Author the fix (a spec or a direct patch) and escort it to green",
  ],
  regression: [
    "Review every regression alert the test sweep raises",
    "Dismiss false / flaky regressions with a written rationale",
    "Author a fix spec for the real ones, directly on the roadmap",
  ],
  "security-review": [
    "Give every merged diff an autonomous security pass (injection / secret-leak / authz / RLS)",
    "Classify each finding (real-vuln / needs-human / false-positive); escalate, never auto-mutate",
    "Watch dependencies for CVEs; author the upgrade-fix spec for owner-gated Build",
  ],
  db_health: [
    "Watch slow queries + table growth across the schema",
    "EXPLAIN-diagnose the offending query path",
    "Propose the index / migration that fixes it (owner-approved)",
  ],
  "coverage-register": [
    "Catch loops + jobs running unregistered in the Control Tower",
    "Propose the MONITORED_LOOPS registry entry (or an exemption)",
    "Keep every background loop heartbeat-watched, no blind spots",
  ],
  "spec-test": [
    "Verify shipped specs still hold against live prod state",
    "Catch false-✅ specs + drift from their verification checklist",
    "Flag regressions back to the owning function as fix work",
  ],
  build: [
    "Claim queued build jobs off the roadmap",
    "Build the spec on the box with native tools, phase by phase",
    "Keep `tsc --noEmit` clean and open a `claude/*` PR",
  ],
  "migration-fix": [
    "Diagnose failed Appstle→internal migration_audits rows",
    "Apply the judgment fixes the mechanical auto-heal punts",
    "Reconcile migration-file drift vs the live DB; re-verify to clear",
  ],
  "pr-resolve": [
    "Resolve dirty / conflicted PRs in the merge queue",
    "Dedupe overlapping branches, rebase onto the default branch",
    "Keep the queue clean so the owner can squash-merge cleanly",
  ],
  fold: [
    "Fold every fully-shipped, owner-verified spec into the brain",
    "Cross-link the lifecycle/table/library/inngest pages it touched",
    "Archive + `git rm` the spec so the brain stays canonical",
  ],
  monitor: [
    "Watch heartbeats / loops / error rates across the system",
    "Raise alerts when a loop stalls or errors spike",
    "Feed unhandled errors into the error→repair pipeline",
  ],
  plan: [
    "Decompose a goal into a milestone → spec tree",
    "Wire blocked_by dependencies between specs",
    "Assign each leaf spec an owner function + a parent (no orphans)",
  ],
  "product-seed": [
    "Take a new product from nothing to published",
    "Pull product intelligence + build the storefront page",
    "Seed the catalog rows + variants so it's orderable",
  ],
  "spec-chat": [
    "Answer authoring questions about a specific spec on the roadmap",
    "Turn the chat thread into concrete spec edits",
    "Keep the roadmap spec accurate to what was decided",
  ],
  "dev-ask": [
    "Answer read-only 'why / how / is it working' developer questions",
    "Investigate the code + live state to ground the answer",
    "Never mutate — surface findings back to the message center",
  ],
};

/** A neutral fallback so a NEW function/*.md or worker with no persona entry still renders. */
function defaultPersona(slug: string, label?: string): AgentPersona {
  const name = label || slug.replace(/(^|[-_])(\w)/g, (_m, sep, c) => (sep ? " " : "") + c.toUpperCase());
  return {
    key: slug, name, role: name, emoji: "🤖",
    personality: "Awaiting a persona — add an entry in personas.ts to reskin.",
    mascotId: "default",
    chip: "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
    dot: "bg-zinc-400", ring: "bg-zinc-50 dark:bg-zinc-800/40", accent: "text-zinc-500 dark:text-zinc-400",
  };
}

/** Resolve a persona by function slug, worker kind, or "ceo"; falls back to a neutral persona. */
export function getPersona(slug: string, label?: string): AgentPersona {
  const base = PERSONAS[slug] ?? defaultPersona(slug, label);
  const responsibilities = RESPONSIBILITIES[slug];
  return responsibilities ? { ...base, responsibilities } : base;
}
