/**
 * Unit test for the Phase-2 regression: the `per_ticket_escalation` storyline title on
 * the CS Director digest must show the FULL ticket UUID (36 chars), never a
 * `.slice(0, 8)` prefix that a CS box agent (June's cs-director-call session) could
 * copy verbatim and round-trip into the cx-agent-sdk ticket tool as a malformed id
 * (the `3cc11e10` 22P02 incident). Pins the exact string contract and the
 * anti-truncation invariant.
 *
 *   npx tsx --test src/lib/cs-director-digest.perTicketEscalationTitle.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { perTicketEscalationTitle } from "./cs-director-digest";

const FULL_UUID = "3cc11e10-1234-4abc-89de-0123456789ab";

test("emits the FULL ticket UUID — 36 chars, dashed", () => {
  const title = perTicketEscalationTitle(FULL_UUID);
  assert.equal(title, `Ticket ${FULL_UUID} — CS Director escalated`);
  assert.match(title, new RegExp(FULL_UUID));
});

test("no bare 8-char `.slice(0, 8)` truncation ever appears in the title", () => {
  // The '3cc11e10' incident: an 8-hex stub the agent copies verbatim as a full id.
  // A title that ended in the 8-char prefix followed by ' — ' would recreate the bug.
  const title = perTicketEscalationTitle(FULL_UUID);
  const eightHex = FULL_UUID.slice(0, 8); // "3cc11e10"
  // The prefix does appear (it's a prefix of the full id) — assert it is IMMEDIATELY
  // followed by the next section of the UUID, never by a space + em-dash + suffix.
  assert.doesNotMatch(title, new RegExp(`${eightHex} —`));
  assert.match(title, new RegExp(`${eightHex}-1234-`));
});

test("contract: title format is 'Ticket <uuid> — CS Director escalated'", () => {
  const title = perTicketEscalationTitle(FULL_UUID);
  assert.match(title, /^Ticket [0-9a-f-]{36} — CS Director escalated$/i);
});
