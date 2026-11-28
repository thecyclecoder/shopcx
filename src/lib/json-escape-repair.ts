/**
 * Repair the one malformation box agents keep emitting in their final JSON: a backslash that is not a
 * legal JSON escape. A grader quoting a regex writes `"…\bid\s+like\b…"` — `\s` is not a JSON escape,
 * so JSON.parse throws and the whole verdict reads as "no parseable decisions" (agent-grade parked
 * 2026-11-27 and 2026-11-28 on exactly this). Legal escapes (`\" \\ \/ \b \f \n \r \t \uXXXX`) are kept
 * as-is; any other backslash is doubled so it survives as a literal. Pure.
 */
export function repairInvalidJsonEscapes(s: string): string {
  return s.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, legal: string | undefined) => (legal ? m : "\\\\"));
}
