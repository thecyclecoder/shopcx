-- grep-checks-match-literally-by-default — backfill GrepCheckParams.mode
--
-- New grep checks default to 'literal' (fixed-string -F in both grep lanes) so an author's code
-- snippet like `isFoo(message, query)` matches the literal call site instead of being parsed as a
-- regex group that can never match. To keep every row that currently passes unchanged, stamp every
-- PRE-EXISTING grep check as 'regex' (the behavior it was authored under). Then reclassify to
-- 'literal' only the rows whose pattern looks like a bare call site (an identifier immediately
-- followed by `(`) and carries NONE of the real regex syntax that would prove the author meant a
-- regex — because those are exactly the unpassable code-snippet checks this spec fixes.
--
-- Idempotent: both statements are guarded so a re-run is a no-op (the first only touches rows still
-- lacking `mode`; the second only promotes rows currently stamped 'regex' that match the literal
-- shape). Auto-applied by control-tower migration-drift (applyMergedMigrations).

-- 1) Every existing grep check lacking a mode → 'regex' (preserve current behavior).
UPDATE public.spec_phase_checks
SET params = params || '{"mode":"regex"}'::jsonb
WHERE exec_kind = 'grep'
  AND params IS NOT NULL
  AND jsonb_typeof(params) = 'object'
  AND NOT (params ? 'mode');

-- 2) Of those just-stamped 'regex' rows, demote to 'literal' the ones whose pattern reads like a
--    literal call site — an identifier char immediately followed by `(` — and contains none of the
--    regex markers `|`, `.*`, `\b`, `^`, `$`, or an escaped `\(`. Substring tests use position()
--    (not ~) so the backslash sequences compare as the literal two characters they are stored as.
UPDATE public.spec_phase_checks
SET params = jsonb_set(params, '{mode}', '"literal"')
WHERE exec_kind = 'grep'
  AND params->>'mode' = 'regex'
  AND params->>'pattern' ~ '[A-Za-z_]\('
  AND position('|'  in params->>'pattern') = 0
  AND position('.*' in params->>'pattern') = 0
  AND position('\b' in params->>'pattern') = 0
  AND position('^'  in params->>'pattern') = 0
  AND position('$'  in params->>'pattern') = 0
  AND position('\(' in params->>'pattern') = 0;
