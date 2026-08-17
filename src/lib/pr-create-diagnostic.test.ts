/**
 * Unit tests for `formatPrCreateFailureDiagnostic`
 * ([[../specs/a-merge-stamps-only-the-phases-whose-code-it-actually-contains]] Fix 1).
 *
 * Pins the exact-state fix: a parked build job's `log_tail` must carry the ACTUAL GitHub HTTP
 * status + response body from every failed `ensurePr` attempt — NOT the unrelated Claude usage
 * metadata the pre-Fix generic log_tail carried (parked build job c5c168bc had a log_tail full of
 * token-counting JSON with zero PR-create signal).
 *
 * Run:
 *   npx tsx --test src/lib/pr-create-diagnostic.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatPrCreateFailureDiagnostic, type EnsurePrAttempt } from "@/lib/pr-create-diagnostic";

test("the actual GH HTTP status is named in the diagnostic (not swallowed)", () => {
  const attempts: EnsurePrAttempt[] = [
    { attempt: 1, status: 403, body: '{"message":"You have exceeded a secondary rate limit"}' },
  ];
  const out = formatPrCreateFailureDiagnostic(attempts);
  assert.match(out, /HTTP 403/);
  assert.match(out, /secondary rate limit/);
});

test("every attempt's status + body is preserved — a triage read sees the WHOLE retry ladder", () => {
  const attempts: EnsurePrAttempt[] = [
    { attempt: 1, status: 502, body: "Bad Gateway" },
    { attempt: 2, status: 502, body: "Bad Gateway (retry)" },
    { attempt: 3, status: 403, body: '{"message":"rate limit"}' },
    { attempt: 4, status: 422, body: '{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists"}]}' },
  ];
  const out = formatPrCreateFailureDiagnostic(attempts);
  assert.match(out, /4 attempt\(s\)/);
  assert.match(out, /attempt 1 \(HTTP 502\)/);
  assert.match(out, /attempt 2 \(HTTP 502\)/);
  assert.match(out, /attempt 3 \(HTTP 403\)/);
  assert.match(out, /attempt 4 \(HTTP 422\)/);
  assert.match(out, /pull request already exists/);
});

test("a fetch-threw attempt is labelled distinctly (not conflated with HTTP 0/null)", () => {
  const attempts: EnsurePrAttempt[] = [
    { attempt: 1, status: null, body: "network error: ENOTFOUND api.github.com" },
  ];
  const out = formatPrCreateFailureDiagnostic(attempts);
  assert.match(out, /HTTP \(fetch threw\)/);
  assert.match(out, /ENOTFOUND/);
});

test("bodies are one-lined + truncated so a giant HTML error page can't blow up log_tail", () => {
  const bigBody = "<html>" + "x".repeat(10_000) + "</html>";
  const out = formatPrCreateFailureDiagnostic([{ attempt: 1, status: 500, body: bigBody }]);
  // Formatter caps each attempt body at 400 chars — well under any sane log_tail column limit.
  const attemptLine = out.split("\n").find((l) => l.startsWith("  attempt 1")) ?? "";
  assert.ok(attemptLine.length < 500, `expected attempt line under 500 chars, got ${attemptLine.length}`);
});

test("newlines/whitespace inside a body are collapsed so one attempt = one line", () => {
  const out = formatPrCreateFailureDiagnostic([
    { attempt: 1, status: 500, body: "Line A\nLine B\n\tLine C" },
  ]);
  const attemptLines = out.split("\n").filter((l) => l.startsWith("  attempt 1"));
  assert.equal(attemptLines.length, 1, "one attempt = exactly one output line");
  assert.match(attemptLines[0], /Line A Line B Line C/);
});

test("empty attempts list surfaces a distinct 'worker-internal bug' sentinel — never an empty string", () => {
  const out = formatPrCreateFailureDiagnostic([]);
  assert.notEqual(out, "");
  assert.match(out, /no attempts recorded/);
});

test("the diagnostic header calls out that Claude usage metadata around it is unrelated (triage guidance)", () => {
  const out = formatPrCreateFailureDiagnostic([{ attempt: 1, status: 500, body: "x" }]);
  assert.match(out, /not the surrounding Claude usage metadata/);
});
