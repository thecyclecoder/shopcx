-- spec-goal-branch-pm-flow (Reva alignment) — mark a deploy-watch as guarding an ATOMIC goal→main promotion.
--
-- Under the branch-flow PM model, a COMPLETE goal lands on `main` in ONE atomic merge (M5,
-- `promoteCompleteGoalsToMain` → `mergeGoalBranchIntoMain`), carrying MANY specs' worth of changes in a
-- single Vercel deploy. The deploy-guardian (Reva) previously only watched per-spec `claude/build-*` squash
-- merges and would have left this highest-blast-radius deploy unwatched. We now open a watch on the atomic
-- merge too — but its branch is `goal/{slug}` (not `claude/*`) and it has no single `kind='build'` job, and
-- auto-reverting a WHOLE goal on a hair-trigger regression bar (tuned for tiny per-phase diffs) would be a
-- false-revert of many specs' tested work. So an atomic watch BIASES TO ESCALATE — never auto-revert; a
-- human eyeballs a regression on a goal-sized deploy. This flag is how the verdict path tells the two apart.

alter table public.deploy_watches
  add column if not exists is_atomic boolean not null default false;

comment on column public.deploy_watches.is_atomic is
  'true ⇒ this watch guards an M5 atomic goal→main promotion (a goal/{slug} branch, one deploy carrying many specs). The deploy-guardian escalates a regression on an atomic watch instead of auto-reverting (reverting a whole goal is far costlier than a per-phase revert; a human decides). Default false = a per-spec claude/* deploy (the existing auto-revert path).';
